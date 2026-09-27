/**
 * Edge TTS PoC（仅验证用，不是正式插件）
 *
 * 目的：真机验证 Bob 的 $websocket 能否直连微软 Edge「大声朗读」接口并收到二进制音频，
 * 顺带把当前 Bob 版本里 $data 可用的取字节手段打进日志。步骤见 docs/tasks/01-poc-websocket.md，
 * 结论见 docs/poc-findings.md。
 *
 * 协议事实参考 rany2/edge-tts 7.2.8（constants.py / drm.py / communicate.py），未复制其代码。
 *
 * 正常朗读只做一件事：连 Edge 接口、发两条消息、逐帧打日志、turn.end 后交付 mp3。
 * 另有两个靠「朗读文本」触发的附加模式，只为取证，正式插件里不会有：
 *
 * - 探针模式：文本以 ws://127.0.0.1:端口/... 或 ws://localhost:端口/... 结尾时改连这个本机地址
 *   （scripts/poc/probe_server.py），连三次让服务端抓 Bob 实际写出的握手请求：
 *   握手头放在 header 里（同时塞一个带标记的 headers）、什么头都不传、握手头只放在 headers 里。
 *   三次分别用 close() / close({}) / close({code: 1000}) 收尾。
 * - 诊断模式：文本以 poc-diag 结尾时依次跑：$data 各方法的真实语义、$http 读 Date 头、故意签错时间的握手、
 *   不带握手头的握手、连接被拒、域名不存在，把每种失败下 listenError / listenClose 的样子记下来，
 *   最后正常合成一句。
 * - 诊断二：文本以「poc-diag2 ws://127.0.0.1:端口」结尾时，让本机探针依次扮演握手回 403、
 *   服务端发 Close 帧、TCP 被直接掐断、握手后不吭声这几种故障。
 */

var TAG = "[edge-poc] ";

var TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
var CHROMIUM_FULL_VERSION = "143.0.3650.75";
var CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
var SEC_MS_GEC_VERSION = "1-" + CHROMIUM_FULL_VERSION;
var WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
var VOICE_LIST_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
    "?trustedclienttoken=" + TRUSTED_CLIENT_TOKEN;
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
    " (KHTML, like Gecko) Chrome/" + CHROMIUM_MAJOR_VERSION + ".0.0.0 Safari/537.36" +
    " Edg/" + CHROMIUM_MAJOR_VERSION + ".0.0.0";
var ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
var OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
var WIN_EPOCH_SECONDS = 11644473600;
var SOCKET_TIMEOUT_SECONDS = 30;
var SETTLE_SECONDS = 1.5;

var VOICES = {
    "zh-Hans": "zh-CN-XiaoxiaoNeural",
    "zh-Hant": "zh-CN-XiaoxiaoNeural",
    "en": "en-US-AriaNeural"
};
// Bob 先自己判断语种，不在 supportLanguages 里的直接报错、不会调到插件；纯网址会被判成德语，
// 所以触发词允许前面带几个汉字，例如「探针 ws://127.0.0.1:18765/probe」「诊断 poc-diag」
var PROBE_URL_RE = /(?:^|\s)(ws:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}(?:\/\S*)?)\s*$/;
var DIAG_RE = /(?:^|\s)poc-diag\s*$/i;
var DIAG2_RE = /(?:^|\s)poc-diag2\s+(ws:\/\/(?:127\.0\.0\.1|localhost):\d{2,5})\s*$/i;
var SHORT_TIMEOUT_SECONDS = 8;
var DIAG_TEXT = "诊断完成";

// Bob 的回调由原生侧持有，这里再留一份引用，避免合成途中 socket 被回收
var liveSockets = [];

// ---------------------------------------------------------------- SHA-256

var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
}

function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
            var d = str.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                i++;
            }
        }
        if (c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0x10000) {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return out;
}

function sha256HexOfBytes(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var byteLength = bytes.length;
    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) {
        msg.push(0);
    }
    // 位长度是 64 位大端；高 32 位用除法算，避免移位溢出
    var bitsHi = Math.floor(byteLength / 0x20000000);
    var bitsLo = (byteLength << 3) >>> 0;
    msg.push((bitsHi >>> 24) & 255, (bitsHi >>> 16) & 255, (bitsHi >>> 8) & 255, bitsHi & 255);
    msg.push((bitsLo >>> 24) & 255, (bitsLo >>> 16) & 255, (bitsLo >>> 8) & 255, bitsLo & 255);

    var w = new Array(64);
    for (var off = 0; off < msg.length; off += 64) {
        var t;
        for (t = 0; t < 16; t++) {
            var p = off + t * 4;
            w[t] = (msg[p] << 24) | (msg[p + 1] << 16) | (msg[p + 2] << 8) | msg[p + 3];
        }
        for (t = 16; t < 64; t++) {
            var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
            var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (t = 0; t < 64; t++) {
            var bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            var ch = (e & f) ^ (~e & g);
            var temp1 = (hh + bigS1 + ch + SHA256_K[t] + w[t]) | 0;
            var bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (bigS0 + maj) | 0;
            hh = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }
        h[0] = (h[0] + a) | 0;
        h[1] = (h[1] + b) | 0;
        h[2] = (h[2] + c) | 0;
        h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0;
        h[5] = (h[5] + f) | 0;
        h[6] = (h[6] + g) | 0;
        h[7] = (h[7] + hh) | 0;
    }
    var hex = "";
    for (var i = 0; i < 8; i++) {
        hex += ("00000000" + (h[i] >>> 0).toString(16)).slice(-8);
    }
    return hex;
}

function sha256Hex(str) {
    return sha256HexOfBytes(utf8Bytes(str));
}

// ---------------------------------------------------------------- Sec-MS-GEC

function gecPlaintext(unixSeconds) {
    var sec = Math.floor(unixSeconds) + WIN_EPOCH_SECONDS;
    sec = sec - (sec % 300);
    // 乘 10^7 用字符串拼接：结果超过 2^53，走浮点会丢精度或变成科学计数法
    return String(sec) + "0000000" + TRUSTED_CLIENT_TOKEN;
}

function secMsGec(unixSeconds) {
    return sha256Hex(gecPlaintext(unixSeconds)).toUpperCase();
}

function selfTest() {
    var cases = [
        ["sha256(abc)", sha256Hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
        ["plaintext(1700000000)", gecPlaintext(1700000000),
            "1334447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4"],
        ["gec(1700000000)", secMsGec(1700000000),
            "42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF"],
        ["plaintext(1760000000.789)", gecPlaintext(1760000000.789),
            "1340447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4"],
        ["gec(1760000000.789)", secMsGec(1760000000.789),
            "70AED27457006C255086B4F079B9FE44A4D10827C4AFDFC3C45583B6F40D7DDF"]
    ];
    var failures = [];
    for (var i = 0; i < cases.length; i++) {
        if (cases[i][1] !== cases[i][2]) {
            failures.push(cases[i][0] + " got=" + cases[i][1] + " want=" + cases[i][2]);
        }
    }
    return failures;
}

// ---------------------------------------------------------------- 报文

function randomHex(length, upper) {
    var chars = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    var out = "";
    for (var i = 0; i < length; i++) {
        out += chars.charAt(Math.floor(Math.random() * 16));
    }
    return out;
}

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

// UTC 时间的 JS Date.toString() 风格：Fri Sep 25 2026 10:00:00 GMT+0000 (Coordinated Universal Time)
function dateString(date) {
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return days[date.getUTCDay()] + " " + months[date.getUTCMonth()] + " " + pad2(date.getUTCDate()) +
        " " + date.getUTCFullYear() + " " + pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes()) +
        ":" + pad2(date.getUTCSeconds()) + " GMT+0000 (Coordinated Universal Time)";
}

function escapeXml(text) {
    return text
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildUrl(base, now, skewSeconds) {
    return base +
        "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN +
        "&ConnectionId=" + randomHex(32, false) +
        "&Sec-MS-GEC=" + secMsGec(now.getTime() / 1000 + (skewSeconds || 0)) +
        "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION;
}

function buildHeader() {
    return {
        "User-Agent": USER_AGENT,
        "Origin": ORIGIN,
        "Cookie": "muid=" + randomHex(32, true) + ";",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Language": "en-US,en;q=0.9"
    };
}

function buildSpeechConfig(now) {
    return "X-Timestamp:" + dateString(now) + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
        '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
        '"outputFormat":"' + OUTPUT_FORMAT + '"}}}}\r\n';
}

function buildSsml(now, voice, text) {
    // X-Timestamp 末尾多出的 Z 是微软侧的历史 bug，照抄
    return "X-RequestId:" + randomHex(32, false) + "\r\n" +
        "Content-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + dateString(now) + "Z\r\n" +
        "Path:ssml\r\n\r\n" +
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='" + voice + "'>" +
        "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" + escapeXml(text) + "</prosody>" +
        "</voice></speak>";
}

// ---------------------------------------------------------------- 取证辅助

function log(message) {
    $log.info(TAG + message);
}

function attempt(fn) {
    try {
        return fn();
    } catch (e) {
        return "THROWN:" + String(e);
    }
}

function propertyNames(obj) {
    if (obj === null || obj === undefined) {
        return String(obj);
    }
    var names = [];
    var cur = obj;
    for (var depth = 0; cur && depth < 4; depth++) {
        var own = attempt(function () { return Object.getOwnPropertyNames(cur); });
        names.push(typeof own === "string" ? own : own.join(","));
        cur = attempt(function () { return Object.getPrototypeOf(cur); });
        if (typeof cur === "string") {
            break;
        }
    }
    return names.join(" | ");
}

function describe(value) {
    var out = "typeof=" + typeof value +
        " json=" + attempt(function () { return JSON.stringify(value); }) +
        " string=" + attempt(function () { return String(value); });
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
        out += " names=" + propertyNames(value);
    }
    return out;
}

function asciiOf(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}

function delay(seconds, handler) {
    return $timer.schedule({ interval: seconds, repeats: false, handler: handler });
}

// ---------------------------------------------------------------- 帧解析

// 同一帧用每一种可用手段各取一遍长度、头长度 N 和头文本，互相对账
function inspectFrame(data) {
    var info = {
        typeofData: typeof data,
        isData: attempt(function () { return $data.isData(data); }),
        typeofLength: typeof data.length,
        lengthInData: attempt(function () { return "length" in data; }),
        typeofToByteArray: typeof data.toByteArray,
        typeofReadUInt8: typeof data.readUInt8,
        typeofToHex: typeof data.toHex,
        typeofSubData: typeof data.subData,
        typeofToUTF8: typeof data.toUTF8,
        typeofToBase64: typeof data.toBase64,
        typeofAppendData: typeof data.appendData
    };

    var bytes = null;
    if (info.typeofToByteArray === "function") {
        bytes = attempt(function () { return data.toByteArray(); });
        info.byteArrayIsArray = Array.isArray(bytes);
        if (!info.byteArrayIsArray) {
            info.byteArrayError = String(bytes);
            bytes = null;
        }
    }
    var hex = null;
    if (info.typeofToHex === "function") {
        hex = attempt(function () { return data.toHex(); });
        if (typeof hex !== "string" || hex.indexOf("THROWN:") === 0) {
            info.hexError = String(hex);
            hex = null;
        }
    }

    info.lengthProp = info.typeofLength === "number" ? data.length : null;
    info.lengthByteArray = bytes ? bytes.length : null;
    info.lengthHex = hex !== null ? hex.length / 2 : null;
    var length = info.lengthProp;
    if (length === null) {
        length = info.lengthByteArray !== null ? info.lengthByteArray : info.lengthHex;
    }
    info.length = length;

    info.nReadUInt8 = info.typeofReadUInt8 === "function"
        ? attempt(function () { return (data.readUInt8(0) << 8) | data.readUInt8(1); })
        : null;
    info.nByteArray = bytes && bytes.length >= 2 ? ((bytes[0] << 8) | bytes[1]) : null;
    info.nHex = hex !== null && hex.length >= 4 ? parseInt(hex.slice(0, 4), 16) : null;
    var n = info.nByteArray;
    if (n === null) {
        n = info.nHex !== null ? info.nHex : info.nReadUInt8;
    }
    info.n = n;

    info.wellFormed = typeof n === "number" && typeof length === "number" && 2 + n <= length;
    if (!info.wellFormed) {
        return { info: info, headerText: null, audio: null, audioLength: 0 };
    }

    var headerFromBytes = bytes ? asciiOf(bytes.slice(2, 2 + n)) : null;
    var headerFromSubData = info.typeofSubData === "function" && n > 0
        ? attempt(function () { return data.subData(2, 2 + n).toUTF8(); })
        : null;
    var headerText = headerFromBytes !== null ? headerFromBytes : headerFromSubData;
    info.headerAgree = headerFromBytes === null || headerFromSubData === null ||
        headerFromBytes === headerFromSubData;
    info.startsWithRequestId = typeof headerText === "string" && headerText.indexOf("X-RequestId:") === 0;

    var audioLength = length - 2 - n;
    var audio = null;
    if (audioLength > 0) {
        if (info.typeofSubData === "function") {
            var sub = attempt(function () { return data.subData(2 + n, length); });
            info.subDataTail = describeData(sub);
            if (byteCount(sub) === audioLength) {
                audio = sub;
                info.audioVia = "subData";
            }
        }
        if (audio === null && bytes) {
            audio = $data.fromByteArray(bytes.slice(2 + n));
            info.audioVia = "fromByteArray";
        }
        if (audio === null && hex !== null) {
            audio = $data.fromHex(hex.slice(4 + 2 * n));
            info.audioVia = "fromHex";
        }
    }
    return { info: info, headerText: headerText, audio: audio, audioLength: audioLength };
}

function headerValue(headerText, name) {
    var lines = String(headerText).split("\r\n");
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(name + ":") === 0) {
            return lines[i].slice(name.length + 1);
        }
    }
    return null;
}

function dataLength(data) {
    if (typeof data.length === "number") {
        return data.length;
    }
    if (typeof data.toByteArray === "function") {
        return data.toByteArray().length;
    }
    return data.toHex().length / 2;
}

// 不是 $data（undefined、null、异常文本……）时返回 -1
function byteCount(value) {
    if (value === null || value === undefined || typeof value !== "object" || typeof value.toHex !== "function") {
        return -1;
    }
    var hex = attempt(function () { return value.toHex(); });
    return typeof hex === "string" && hex.indexOf("THROWN:") !== 0 ? hex.length / 2 : -1;
}

function describeData(value) {
    var count = byteCount(value);
    if (count < 0) {
        return "非$data:" + (value === null ? "null" : typeof value) +
            (typeof value === "string" ? "(" + value + ")" : "");
    }
    var hex = value.toHex();
    return count + "字节:" + (hex.length > 40 ? hex.slice(0, 16) + "…" + hex.slice(-8) : hex);
}

// ---------------------------------------------------------------- 诊断：$data 的真实语义

function probeDataApi() {
    var d = $data.fromByteArray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    log("data10 names(instance)=" + propertyNames(d));
    log("data10 typeof length=" + typeof d.length + " 'length' in=" + attempt(function () { return "length" in d; }) +
        " typeof byteLength=" + typeof d.byteLength + " typeof count=" + typeof d.count +
        " typeof size=" + typeof d.size + " d[0]=" + attempt(function () { return String(d[0]); }) +
        " String(d)=" + attempt(function () { return String(d); }) +
        " JSON=" + attempt(function () { return JSON.stringify(d); }));
    log("data10 toHex()=" + attempt(function () { return d.toHex(); }) +
        " toHex(true)=" + attempt(function () { return d.toHex(true); }) +
        " toBase64()=" + attempt(function () { return d.toBase64(); }) +
        " toByteArray()=" + attempt(function () { return JSON.stringify(d.toByteArray()); }) +
        " isArray=" + attempt(function () { return Array.isArray(d.toByteArray()); }));
    var reads = [0, 9, 10, 11, -1, 1.5, "2"];
    log("data10 readUInt8 " + reads.map(function (i) {
        return "(" + JSON.stringify(i) + ")=" + attempt(function () { return String(d.readUInt8(i)); });
    }).join(" "));
    var ranges = [[0, 10], [0, 9], [2, 10], [2, 9], [9, 10], [8, 9], [0, 1], [5, 5], [5, 4], [0, 11], [10, 10], [10, 11], [-1, 3]];
    for (var i = 0; i < ranges.length; i++) {
        (function (r) {
            log("data10 subData(" + r[0] + "," + r[1] + ")=" +
                describeData(attempt(function () { return d.subData(r[0], r[1]); })));
        })(ranges[i]);
    }
    log("data10 subData(3)=" + describeData(attempt(function () { return d.subData(3); })) +
        " subData()=" + describeData(attempt(function () { return d.subData(); })));

    var copy = $data.fromData(d);
    var appendReturn = attempt(function () { return copy.appendData($data.fromByteArray([255, 254])); });
    log("data10 fromData+appendData copy=" + describeData(copy) + " original=" + describeData(d) +
        " appendData返回=" + describeData(appendReturn) + "/" + typeof appendReturn);
    var writeReturn = attempt(function () { return copy.writeUInt8(170, 0); });
    log("data10 writeUInt8(170,0) copy=" + describeData(copy) + " 返回=" + typeof writeReturn);
    var empty = attempt(function () { return $data.fromByteArray([]); });
    log("data empty=" + describeData(empty) + " toBase64=" + attempt(function () { return JSON.stringify(empty.toBase64()); }) +
        " toUTF8=" + attempt(function () { return JSON.stringify(empty.toUTF8()); }));
    log("data fromUTF8(你好).toHex=" + attempt(function () { return $data.fromUTF8("你好").toHex(); }) +
        " fromHex(FFF3).toUTF8=" + attempt(function () { return String($data.fromHex("FFF3").toUTF8()); }) +
        " fromBase64(AAEC).toHex=" + attempt(function () { return $data.fromBase64("AAEC").toHex(); }) +
        " isData(d)=" + attempt(function () { return $data.isData(d); }) +
        " isData('x')=" + attempt(function () { return $data.isData("x"); }) +
        " isData({})=" + attempt(function () { return $data.isData({}); }));

    // 大块数据上各种取法的耗时，决定正式实现走哪条路
    var big = [];
    for (var k = 0; k < 200000; k++) {
        big.push(k & 255);
    }
    var t0 = Date.now();
    var bigData = $data.fromByteArray(big);
    var t1 = Date.now();
    var arr = bigData.toByteArray();
    var t2 = Date.now();
    var hex = bigData.toHex();
    var t3 = Date.now();
    var b64 = bigData.toBase64();
    var t4 = Date.now();
    var sub = attempt(function () { return bigData.subData(130, 199999); });
    var t5 = Date.now();
    var acc = $data.fromByteArray([]);
    for (var m = 0; m < 200; m++) {
        acc.appendData(bigData.subData(m * 1000, m * 1000 + 999));
    }
    var t6 = Date.now();
    log("data200k ms fromByteArray=" + (t1 - t0) + " toByteArray=" + (t2 - t1) + "(" + arr.length + ")" +
        " toHex=" + (t3 - t2) + "(" + hex.length + ")" + " toBase64=" + (t4 - t3) + "(" + b64.length + ")" +
        " subData=" + (t5 - t4) + "(" + byteCount(sub) + ")" +
        " 200次subData+appendData=" + (t6 - t5) + "(" + byteCount(acc) + ")");
}

// ---------------------------------------------------------------- 一次连接

/**
 * 连一次、发两条消息、收到 turn.end 或出错为止。
 * opts: label, url, header（可省）, extraParams（可省）, voice, text, settleSeconds,
 *       closeForm（"noarg" 即 close()、"empty" 即 close({})、"code" 即 close({code: 1000})，缺省 "empty"）,
 *       timeoutInterval（传给 $websocket.new，缺省 30）, timeoutSeconds（插件自己的定时器，缺省 30）
 * done(result): result.audio 是拼好的 $data，失败时 result.error 是 { type, message, addition }
 *
 * settleSeconds > 0 时，结束后不主动 close()，先等这么久看还有哪些事件自己冒出来，
 * 再 close() 并回调；等于 0 时立刻 close() 并回调（正常朗读走这条）。
 */
function runSession(opts, done) {
    var label = opts.label;
    var startedAt = Date.now();
    var seq = 0;
    var finished = false;
    var timerId = null;
    var loggedApi = false;
    var audio = null;
    var stats = {
        label: label,
        textFrames: 0,
        binaryFrames: 0,
        audioFrames: 0,
        emptyAudioFrames: 0,
        malformedFrames: 0,
        audioBytes: 0,
        minFrame: null,
        maxFrame: null,
        events: [],
        openMs: null,
        firstAudioMs: null,
        turnEndMs: null
    };

    function closeSocket() {
        var form = opts.closeForm || "empty";
        var ret = attempt(function () {
            if (form === "noarg") {
                return String(socket.close());
            }
            return String(socket.close(form === "code" ? { code: 1000 } : {}));
        });
        ev("CALLED close", "form=" + form + " ret=" + ret +
            " readyState=" + attempt(function () { return socket.readyState; }));
    }

    function ev(name, detail) {
        seq++;
        var ms = Date.now() - startedAt;
        if (name !== "TEXT" && name !== "DATA") {
            stats.events.push(name + "@" + ms + (finished ? "*" : ""));
        }
        log(label + " #" + seq + " +" + ms + "ms " + name + (finished ? " (结束之后)" : "") +
            (detail ? " " + detail : ""));
    }

    function finish(result) {
        if (finished) {
            return;
        }
        finished = true;
        if (timerId !== null) {
            $timer.invalidate(timerId);
            timerId = null;
        }
        stats.finishMs = Date.now() - startedAt;
        result.stats = stats;
        if (!opts.settleSeconds) {
            closeSocket();
            log(label + " SUMMARY " + JSON.stringify(stats));
            done(result);
            return;
        }
        delay(opts.settleSeconds, function () {
            ev("SETTLED", "readyState=" + attempt(function () { return socket.readyState; }));
            closeSocket();
            delay(1.0, function () {
                log(label + " SUMMARY " + JSON.stringify(stats));
                done(result);
            });
        });
    }

    function fail(type, message, addition) {
        ev("FAIL", "type=" + type + " message=" + message);
        finish({ error: { type: type, message: message, addition: addition } });
    }

    var params = {
        url: opts.url,
        allowSelfSignedSSLCertificates: false,
        timeoutInterval: opts.timeoutInterval || SOCKET_TIMEOUT_SECONDS
    };
    if (opts.header) {
        params.header = opts.header;
    }
    for (var key in (opts.extraParams || {})) {
        params[key] = opts.extraParams[key];
    }
    log(label + " connect url=" + opts.url.replace(/ConnectionId=[0-9a-f]+/, "ConnectionId=<32hex>"));
    log(label + " connect params=" + JSON.stringify(params, function (k, v) { return k === "url" ? undefined : v; }));

    var socket = $websocket.new(params);
    liveSockets.push(socket);
    log(label + " api socket=" + propertyNames(socket));

    socket.listenOpen(function (s) {
        stats.openMs = Date.now() - startedAt;
        ev("OPEN", "args=" + arguments.length + " readyState=" + s.readyState + " sameSocket=" + (s === socket));
        var sendAt = new Date();
        var config = buildSpeechConfig(sendAt);
        var ssml = buildSsml(sendAt, opts.voice, opts.text);
        ev("SEND speech.config", "chars=" + config.length +
            " ret=" + attempt(function () { return String(s.sendString(config)); }));
        ev("SEND ssml", "chars=" + ssml.length +
            " ret=" + attempt(function () { return String(s.sendString(ssml)); }));
    });

    socket.listenError(function (s, error) {
        ev("ERROR", "args=" + arguments.length +
            " readyState=" + attempt(function () { return s.readyState; }) +
            " code=" + attempt(function () { return error.code; }) +
            " type=" + attempt(function () { return error.type; }) +
            " message=" + attempt(function () { return error.message; }) +
            " " + describe(error));
        if (finished) {
            return;
        }
        fail("api", "WebSocket 握手或传输出错，详见日志", {
            code: attempt(function () { return error.code; }),
            type: attempt(function () { return error.type; }),
            message: attempt(function () { return error.message; })
        });
    });

    socket.listenClose(function (s, code, reason) {
        ev("CLOSE", "args=" + arguments.length +
            " readyState=" + attempt(function () { return s.readyState; }) +
            " code=" + describe(code) + " reason=" + describe(reason));
        if (finished) {
            return;
        }
        fail("api", "连接在 turn.end 之前被关闭", { code: code, reason: String(reason) });
    });

    socket.listenReceiveString(function (s, string) {
        stats.textFrames++;
        var str = String(string);
        var path = headerValue(str.split("\r\n\r\n")[0], "Path");
        ev("TEXT", "n=" + stats.textFrames + " args=" + arguments.length + " typeof=" + typeof string +
            " chars=" + str.length +
            " path=" + path + " head200=" + JSON.stringify(str.slice(0, 200)));
        if (path !== "turn.end" || finished) {
            return;
        }
        stats.turnEndMs = Date.now() - startedAt;
        if (!audio) {
            fail("api", "收到 turn.end 但没有音频", null);
            return;
        }
        stats.audioBytesFromData = dataLength(audio);
        if (typeof audio.toByteArray === "function" && stats.audioBytes <= 2 * 1024 * 1024) {
            stats.audioSha256 = sha256HexOfBytes(audio.toByteArray());
        }
        finish({ audio: audio });
    });

    socket.listenReceiveData(function (s, data) {
        stats.binaryFrames++;
        if (!loggedApi) {
            loggedApi = true;
            log(label + " api data=" + propertyNames(data));
        }
        var frame = inspectFrame(data);
        var size = frame.info.length;
        stats.minFrame = stats.minFrame === null ? size : Math.min(stats.minFrame, size);
        stats.maxFrame = stats.maxFrame === null ? size : Math.max(stats.maxFrame, size);
        // 头几帧把每种取法都打出来；后面的帧只打对账结果，免得长文本刷出上千行
        var verbose = stats.binaryFrames <= 3 || !frame.info.wellFormed || !frame.info.headerAgree ||
            frame.audioLength === 0;
        ev("DATA", "n=" + stats.binaryFrames + " args=" + arguments.length + " length=" + size + " N=" + frame.info.n +
            " audioBytes=" + frame.audioLength + " wellFormed=" + frame.info.wellFormed +
            (verbose ? " info=" + JSON.stringify(frame.info) + " header=" + JSON.stringify(frame.headerText) : ""));
        if (!frame.info.wellFormed) {
            stats.malformedFrames++;
            return;
        }
        if (finished || headerValue(frame.headerText, "Path") !== "audio") {
            return;
        }
        if (frame.audioLength === 0) {
            // 结束前那帧只有 Path:audio、没有 Content-Type 也没有数据
            stats.emptyAudioFrames++;
            return;
        }
        if (headerValue(frame.headerText, "Content-Type") !== "audio/mpeg") {
            ev("WARN", "有音频数据但 Content-Type 不是 audio/mpeg");
        }
        if (!frame.audio || typeof frame.audio === "string") {
            fail("unknown", "取不出音频字节", frame.info);
            return;
        }
        stats.audioFrames++;
        stats.audioBytes += frame.audioLength;
        if (stats.firstAudioMs === null) {
            stats.firstAudioMs = Date.now() - startedAt;
        }
        if (audio) {
            audio.appendData(frame.audio);
        } else {
            audio = $data.fromData(frame.audio);
        }
    });

    var timeoutSeconds = opts.timeoutSeconds || SOCKET_TIMEOUT_SECONDS;
    timerId = delay(timeoutSeconds, function () {
        timerId = null;
        ev("TIMER", "插件自己的定时器到点 readyState=" + attempt(function () { return socket.readyState; }));
        fail("network", timeoutSeconds + " 秒内没有收到 turn.end", null);
    });
    log(label + " timer id typeof=" + typeof timerId + " value=" + timerId);

    ev("CALL open()", "readyState=" + attempt(function () { return socket.readyState; }) +
        " ret=" + attempt(function () { return String(socket.open()); }));
}

// ---------------------------------------------------------------- 诊断：$http 的 Date 头

function probeHttpDate(done) {
    var startedAt = Date.now();
    log("http GET voices/list");
    $http.request({
        method: "GET",
        url: VOICE_LIST_URL,
        header: { "User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9" },
        timeout: 15,
        handler: function (resp) {
            var receivedAt = Date.now();
            var response = resp ? resp.response : null;
            var headers = response ? response.headers : null;
            log("http ms=" + (receivedAt - startedAt) + " resp names=" + propertyNames(resp) +
                " error=" + attempt(function () { return JSON.stringify(resp.error); }));
            log("http response statusCode=" + attempt(function () { return response.statusCode; }) +
                " names=" + propertyNames(response));
            log("http header keys=" + attempt(function () { return Object.keys(headers).join(","); }));
            log("http headers.Date=" + attempt(function () { return JSON.stringify(headers.Date); }) +
                " headers.date=" + attempt(function () { return JSON.stringify(headers.date); }) +
                " headers['DATE']=" + attempt(function () { return JSON.stringify(headers.DATE); }));
            var raw = attempt(function () { return headers.Date || headers.date; });
            var parsed = Date.parse(raw);
            log("http Date.parse=" + parsed + " skewSeconds(server-local)=" +
                (isNaN(parsed) ? "NaN" : Math.round((parsed - receivedAt) / 1000)));
            log("http data typeof=" + typeof resp.data + " isArray=" + Array.isArray(resp.data) +
                " voices=" + attempt(function () { return resp.data.length; }) +
                " rawData=" + attempt(function () { return propertyNames(resp.rawData); }));
            var wanted = [VOICES["zh-Hans"], VOICES.en];
            var found = attempt(function () {
                return resp.data.filter(function (v) { return wanted.indexOf(v.ShortName) >= 0; })
                    .map(function (v) { return v.ShortName; }).join(",");
            });
            log("http voices found=" + found);
            done();
        }
    });
}

// ---------------------------------------------------------------- 插件入口

// Bob 自己的语种检测会把网址、短句判成别的语种，为了让探针和诊断的触发文本也能送到插件，
// 这里把常见语种都列上；除了英文用 Aria，其余一律用晓晓，PoC 不关心念得对不对
function supportLanguages() {
    return ["zh-Hans", "zh-Hant", "yue", "en", "ja", "ko", "fr", "de", "es", "it", "ru", "pt", "nl", "pl",
        "ar", "tr", "vi", "th", "id", "ms", "sv", "da", "fi", "no", "cs", "el", "he", "hi", "hu", "ro",
        "sk", "uk", "la"];
}

function pluginTimeoutInterval() {
    return 60;
}

function tts(query, completion) {
    var startedAt = Date.now();
    var text = String(query.text || "");
    var probeMatch = text.match(PROBE_URL_RE);
    var diag2Match = text.match(DIAG2_RE);
    var mode = diag2Match ? "diag2" : (probeMatch ? "probe" : (DIAG_RE.test(text) ? "diag" : "edge"));
    var voice = VOICES[query.lang] || VOICES["zh-Hans"];
    var delivered = false;

    function deliver(result) {
        if (delivered) {
            log("deliver 被重复调用，已忽略");
            return;
        }
        delivered = true;
        if (result.error) {
            var err = result.error;
            log("END mode=" + mode + " ms=" + (Date.now() - startedAt) + " error=" + JSON.stringify(err));
            // Bob 旧文档的字段拼写是 addtion，现行文档是 addition，两个都填
            completion({ error: { type: err.type, message: err.message, addtion: err.addition, addition: err.addition } });
            return;
        }
        var value = result.audio.toBase64();
        log("END mode=" + mode + " ms=" + (Date.now() - startedAt) + " audioBytes=" + result.stats.audioBytes +
            " base64Chars=" + value.length);
        completion({ result: { type: "base64", value: value, raw: {} } });
    }

    log("BEGIN mode=" + mode + " lang=" + query.lang + " voice=" + voice + " chars=" + text.length +
        " queryKeys=" + Object.keys(query).join(",") +
        " bob=" + attempt(function () { return $env.appVersion + "(" + $env.appBuild + ")"; }) +
        " os=" + attempt(function () { return $env.macOSVersion; }) +
        " now=" + new Date().toISOString());

    var failures = selfTest();
    if (failures.length) {
        deliver({ error: { type: "unknown", message: "SHA-256 / Sec-MS-GEC 自测未通过", addition: failures } });
        return;
    }
    log("selftest ok (5 vectors)");
    log("api $websocket=" + propertyNames($websocket));
    log("api $data=" + propertyNames($data));
    log("api $timer=" + propertyNames($timer));

    function edgeSession(label, sessionText, settleSeconds, done) {
        runSession({
            label: label,
            url: buildUrl(WSS_URL, new Date(), 0),
            header: buildHeader(),
            voice: voice,
            text: sessionText,
            settleSeconds: settleSeconds
        }, done);
    }

    if (mode === "edge") {
        edgeSession("edge", text, 0, deliver);
        return;
    }

    if (mode === "probe") {
        var probeUrl = probeMatch[1];
        var origin = probeUrl.match(/^ws:\/\/[^\/]+/)[0];
        var header = buildHeader();
        header["X-Poc-Param"] = "header";
        runSession({
            label: "probe-full",
            url: buildUrl(probeUrl, new Date(), 0),
            header: header,
            extraParams: { headers: { "X-Poc-Param": "headers" } },
            voice: voice,
            text: text,
            settleSeconds: SETTLE_SECONDS,
            closeForm: "noarg"
        }, function (first) {
            runSession({
                label: "probe-bare",
                url: buildUrl(origin + "/bare", new Date(), 0),
                voice: voice,
                text: text,
                settleSeconds: SETTLE_SECONDS,
                closeForm: "empty"
            }, function () {
                runSession({
                    label: "probe-plural",
                    url: buildUrl(origin + "/plural", new Date(), 0),
                    extraParams: { headers: buildHeader() },
                    voice: voice,
                    text: text,
                    settleSeconds: SETTLE_SECONDS,
                    closeForm: "code"
                }, function () {
                    deliver(first);
                });
            });
        });
        return;
    }

    function runSteps(steps) {
        var index = 0;
        (function runNext() {
            var step = steps[index++];
            log(mode + " step " + index + "/" + steps.length);
            step(runNext);
        })();
    }

    if (mode === "diag2") {
        // 诊断二：由本机探针扮演出故障的服务端，看每种故障下回调的样子
        var base = diag2Match[1];
        var scenario = function (label, path, extra) {
            return function (next) {
                var opts = {
                    label: label,
                    url: buildUrl(base + path, new Date(), 0),
                    header: buildHeader(),
                    voice: voice,
                    text: DIAG_TEXT,
                    settleSeconds: SETTLE_SECONDS,
                    timeoutSeconds: SHORT_TIMEOUT_SECONDS
                };
                for (var k in (extra || {})) {
                    opts[k] = extra[k];
                }
                runSession(opts, next);
            };
        };
        runSteps([
            function (next) {
                var d = $data.fromByteArray([171, 205, 239, 10]);
                log("data toHex()=" + d.toHex() + " toHex(true)=" + d.toHex(true) + " toHex(false)=" + d.toHex(false));
                next();
            },
            scenario("diag2-reject403", "/reject403"),
            scenario("diag2-close-frame", "/close-frame"),
            scenario("diag2-drop", "/drop"),
            scenario("diag2-hang", "/hang", { timeoutInterval: 3 }),
            function () {
                edgeSession("diag2-edge", DIAG_TEXT, 0, deliver);
            }
        ]);
        return;
    }

    // 诊断模式：每一步都只打日志，失败是预期之中的，最后正常合成一句作为收尾
    var steps = [
        function (next) {
            probeDataApi();
            next();
        },
        function (next) {
            probeHttpDate(next);
        },
        function (next) {
            runSession({
                label: "diag-skew900",
                url: buildUrl(WSS_URL, new Date(), 900),
                header: buildHeader(),
                voice: voice,
                text: DIAG_TEXT,
                settleSeconds: SETTLE_SECONDS
            }, next);
        },
        function (next) {
            runSession({
                label: "diag-noheader",
                url: buildUrl(WSS_URL, new Date(), 0),
                voice: voice,
                text: DIAG_TEXT,
                settleSeconds: SETTLE_SECONDS
            }, next);
        },
        function (next) {
            runSession({
                label: "diag-refused",
                url: "ws://127.0.0.1:1/refused",
                header: buildHeader(),
                voice: voice,
                text: DIAG_TEXT,
                settleSeconds: SETTLE_SECONDS,
                timeoutInterval: 3,
                timeoutSeconds: SHORT_TIMEOUT_SECONDS
            }, next);
        },
        function (next) {
            runSession({
                label: "diag-nxdomain",
                url: "wss://edge-tts-poc.invalid/nxdomain",
                header: buildHeader(),
                voice: voice,
                text: DIAG_TEXT,
                settleSeconds: SETTLE_SECONDS,
                timeoutInterval: 3,
                timeoutSeconds: SHORT_TIMEOUT_SECONDS
            }, next);
        },
        function () {
            edgeSession("diag-edge", DIAG_TEXT, SETTLE_SECONDS, deliver);
        }
    ];
    runSteps(steps);
}

exports.supportLanguages = supportLanguages;
exports.pluginTimeoutInterval = pluginTimeoutInterval;
exports.tts = tts;
