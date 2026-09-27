var config = require("./config.js");

var LOG_TAG = "[edge-tts]";

// Bob 宿主超时。插件自己的总预算必须更短，才有机会把明确的错误交回 Bob。
var PLUGIN_TIMEOUT_INTERVAL = 60;
var TOTAL_BUDGET_MS = 55000;
var VALIDATE_BUDGET_MS = 25000;
// 每条 WebSocket 连接的超时：握手超时交给 Bob，收不到 turn.end 由插件自己的定时器兜底
var CONNECT_TIMEOUT = 30;
var SKEW_PROBE_TIMEOUT = 10;

var MESSAGE_REJECTED = "微软接口拒绝连接，请检查系统时间；若持续失败请更新插件";
var MESSAGE_NO_AUDIO = "未返回音频，请换个音色重试";

// 本机时钟与微软服务器的偏差（毫秒）。握手被拒后测一次，之后的签名都带上它；
// Bob 不重载插件就一直有效。
var clockSkewMs = 0;

// 进行中的连接。Bob 的回调由原生侧持有，这里再留一份引用，避免合成途中 socket 被回收。
var activeSockets = [];

// ---------------------------------------------------------------- 工具函数

function trimmed(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

function readOption(name) {
    return trimmed(typeof $option !== "undefined" && $option ? $option[name] : "");
}

function oneLine(value, limit) {
    var str = value === undefined || value === null ? "" : String(value);
    str = str.replace(/\s+/g, " ").trim();
    var max = limit || 300;
    return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function logInfo(message) {
    if (typeof $log !== "undefined" && $log && typeof $log.info === "function") {
        $log.info(LOG_TAG + " " + message);
    }
}

function logError(message) {
    if (typeof $log !== "undefined" && $log && typeof $log.error === "function") {
        $log.error(LOG_TAG + " " + message);
    } else {
        logInfo(message);
    }
}

// completion 只能调用一次：超时、error、close 可能先后到达
function once(fn, label) {
    var called = false;
    return function (value) {
        if (called) {
            logInfo((label || "completion") + " 已经回调过，忽略重复回调");
            return;
        }
        called = true;
        fn(value);
    };
}

function nowMs() {
    return Date.now();
}

// ---------------------------------------------------------------- SHA-256

// Bob 的运行时没有 crypto，Sec-MS-GEC 需要的 SHA-256 只能自己算。
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

function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            var next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                i += 1;
            }
        }
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
    }
    return bytes;
}

function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
}

// 输入按 UTF-8 编码，输出小写 hex
function sha256Hex(message) {
    var bytes = utf8Bytes(String(message));
    var bitLength = bytes.length * 8;
    var i;

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) {
        bytes.push(0);
    }
    var high = Math.floor(bitLength / 0x100000000);
    var low = bitLength >>> 0;
    bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
    bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);

    for (var offset = 0; offset < bytes.length; offset += 64) {
        for (i = 0; i < 16; i++) {
            var p = offset + i * 4;
            w[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
        }
        for (i = 16; i < 64; i++) {
            var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        var a = h[0];
        var b = h[1];
        var c = h[2];
        var d = h[3];
        var e = h[4];
        var f = h[5];
        var g = h[6];
        var hh = h[7];

        for (i = 0; i < 64; i++) {
            var sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            var choice = (e & f) ^ (~e & g);
            var t1 = (hh + sum1 + choice + SHA256_K[i] + w[i]) >>> 0;
            var sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            var majority = (a & b) ^ (a & c) ^ (b & c);
            var t2 = (sum0 + majority) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }

        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }

    var hex = "";
    for (i = 0; i < 8; i++) {
        hex += ("00000000" + h[i].toString(16)).slice(-8);
    }
    return hex;
}

// ---------------------------------------------------------------- 签名与握手参数

// Sec-MS-GEC 的待哈希字串：FILETIME 刻度（100 纳秒）向下取整到 5 分钟，再拼 TrustedClientToken。
// 秒数乘 10^7 会超过 2^53，所以用整数秒的十进制串后面直接补 7 个 0，不做浮点乘法。
function gecPayload(unixSeconds) {
    var seconds = Math.floor(Number(unixSeconds)) + config.WIN_EPOCH_SECONDS;
    seconds = Math.floor(seconds / config.GEC_WINDOW_SECONDS) * config.GEC_WINDOW_SECONDS;
    return String(seconds) + "0000000" + config.TRUSTED_CLIENT_TOKEN;
}

function secMsGec(unixSeconds) {
    return sha256Hex(gecPayload(unixSeconds)).toUpperCase();
}

function randomHex(length, upper) {
    var chars = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    var out = "";
    for (var i = 0; i < length; i++) {
        out += chars.charAt(Math.floor(Math.random() * 16));
    }
    return out;
}

// 32 位 hex，形同去掉连字符的 UUID v4
function connectionId() {
    var hex = randomHex(32, false);
    var variant = "89ab".charAt(Math.floor(Math.random() * 4));
    return hex.slice(0, 12) + "4" + hex.slice(13, 16) + variant + hex.slice(17);
}

function correctedNowMs() {
    return nowMs() + clockSkewMs;
}

function buildUrl(unixSeconds) {
    return config.WSS_URL +
        "?TrustedClientToken=" + config.TRUSTED_CLIENT_TOKEN +
        "&ConnectionId=" + connectionId() +
        "&Sec-MS-GEC=" + secMsGec(unixSeconds) +
        "&Sec-MS-GEC-Version=" + config.SEC_MS_GEC_VERSION;
}

// Sec-WebSocket-* 由 Bob 的 WebSocket 客户端自己生成，这里不填。
// MUID 每条连接随机生成一次。
function buildHeaders() {
    return {
        "User-Agent": config.USER_AGENT,
        "Origin": config.ORIGIN,
        "Cookie": "muid=" + randomHex(32, true) + ";",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Language": config.ACCEPT_LANGUAGE
    };
}

var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value) {
    return value < 10 ? "0" + value : String(value);
}

// 形如 Thu Sep 25 2026 10:00:00 GMT+0000 (Coordinated Universal Time)
function timestampString(ms) {
    var d = new Date(ms);
    return DAY_NAMES[d.getUTCDay()] + " " + MONTH_NAMES[d.getUTCMonth()] + " " + pad2(d.getUTCDate()) + " " +
        d.getUTCFullYear() + " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" +
        pad2(d.getUTCSeconds()) + " GMT+0000 (Coordinated Universal Time)";
}

function buildConfigMessage(ms) {
    return "X-Timestamp:" + timestampString(ms) + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{" +
        "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}," +
        "\"outputFormat\":\"" + config.OUTPUT_FORMAT + "\"}}}}\r\n";
}

function buildSsml(voiceName, prosody, escapedText) {
    return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='" + voiceName + "'>" +
        "<prosody pitch='" + prosody.pitch + "' rate='" + prosody.rate + "' volume='" + prosody.volume + "'>" +
        escapedText +
        "</prosody></voice></speak>";
}

// X-Timestamp 末尾多出来的 Z 是微软侧的历史 bug，Edge 自己也这么发，照抄
function buildSsmlMessage(ms, voiceName, prosody, escapedText) {
    return "X-RequestId:" + connectionId() + "\r\n" +
        "Content-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + timestampString(ms) + "Z\r\n" +
        "Path:ssml\r\n\r\n" +
        buildSsml(voiceName, prosody, escapedText);
}

// ---------------------------------------------------------------- 文本处理

// 服务端遇到这些控制字符会报错（OCR 出来的 PDF 里常见垂直制表符），统一换成空格。
// 落单的代理项和 U+FFFE / U+FFFF 不是合法的 XML 字符，同样处理。
function cleanText(text) {
    var str = String(text === undefined || text === null ? "" : text)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, " ");
    if (!/[\ud800-\udfff]/.test(str)) {
        return str;
    }
    var out = "";
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                out += str.charAt(i) + str.charAt(i + 1);
                i += 1;
            } else {
                out += " ";
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            out += " ";
        } else {
            out += str.charAt(i);
        }
    }
    return out;
}

function escapeXml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function utf8Length(str) {
    var total = 0;
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code < 0x80) {
            total += 1;
        } else if (code < 0x800) {
            total += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length &&
            str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
            total += 4;
            i += 1;
        } else {
            total += 3;
        }
    }
    return total;
}

// 句末标点：中日文句号叹号问号、分号、省略号、印地语 danda、阿拉伯语问号与句号
var SENTENCE_END = "。！？；…।؟۔";
// 句中停顿：中日文逗号顿号冒号、阿拉伯语逗号与分号
var CLAUSE_BREAK = "，、：،؛";
// 半角标点只有后面跟着空白（或正好在文本末尾）才算断句点，免得把 3.14、1,000 切开
var ASCII_SENTENCE_END = ".!?;";
var ASCII_CLAUSE_BREAK = ",:";
// 紧跟在句末标点后面的引号和括号留在前一段
var CLOSERS = "”’」』）】》〉\"')]}";

function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "　" || ch === " ";
}

// text[index] 是分号时，判断它是不是 &amp; 这类实体的结尾
function endsEntity(text, index) {
    for (var i = index - 1; i >= 0 && index - i <= 6; i--) {
        var ch = text.charAt(i);
        if (ch === "&") {
            return i < index - 1;
        }
        if (!/[A-Za-z0-9#]/.test(ch)) {
            return false;
        }
    }
    return false;
}

// 硬切（窗口里找不到标点和空白）时，切点不能落在 &amp; 这类实体中间
function avoidEntitySplit(text, start, cut) {
    for (var i = cut - 1; i >= start && cut - i <= 6; i--) {
        var ch = text.charAt(i);
        if (ch === ";") {
            return cut;
        }
        if (ch === "&") {
            return i;
        }
    }
    return cut;
}

// 从 start 起最多能放进 maxBytes 字节的位置（不含），按码点前进，不会切开代理对
function windowEnd(text, start, maxBytes) {
    var bytes = 0;
    var i = start;
    while (i < text.length) {
        var code = text.charCodeAt(i);
        var size = 3;
        var units = 1;
        if (code < 0x80) {
            size = 1;
        } else if (code < 0x800) {
            size = 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
            text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
            size = 4;
            units = 2;
        }
        if (bytes + size > maxBytes) {
            break;
        }
        bytes += size;
        i += units;
    }
    return i;
}

// 在 [start, end) 里找最合适的切点，返回切点下标（切点之前的内容归前一段）。
// 优先在后半段的句末 / 换行处切，其次是后半段的逗号 / 空白，再其次是前半段，最后硬切。
function findCut(text, start, end) {
    var half = start + Math.floor((end - start) / 2);
    var strong = -1;
    var weak = -1;

    for (var i = start; i < end; i++) {
        var ch = text.charAt(i);
        var next = i + 1 < text.length ? text.charAt(i + 1) : "";
        var followedBySpace = next === "" || isWhitespace(next);
        var isStrong = false;
        var isWeak = false;

        if (ch === "\n") {
            isStrong = true;
        } else if (SENTENCE_END.indexOf(ch) !== -1) {
            isStrong = true;
        } else if (ASCII_SENTENCE_END.indexOf(ch) !== -1) {
            isStrong = followedBySpace && !(ch === ";" && endsEntity(text, i));
        } else if (CLAUSE_BREAK.indexOf(ch) !== -1 || isWhitespace(ch)) {
            isWeak = true;
        } else if (ASCII_CLAUSE_BREAK.indexOf(ch) !== -1) {
            isWeak = followedBySpace;
        }

        if (isStrong) {
            var after = i + 1;
            while (after < end && CLOSERS.indexOf(text.charAt(after)) !== -1) {
                after += 1;
            }
            strong = after;
        } else if (isWeak) {
            weak = i + 1;
        }
    }

    if (strong > half) {
        return strong;
    }
    if (weak > half) {
        return weak;
    }
    if (strong > start) {
        return strong;
    }
    if (weak > start) {
        return weak;
    }
    return -1;
}

// 把（已转义的）文本切成若干段，每段 UTF-8 字节数不超过 maxBytes。
// 不会切开多字节字符，也不会切开 XML 实体。
function splitText(text, maxBytes) {
    var limit = Math.max(16, Math.floor(Number(maxBytes) || config.MAX_SEGMENT_BYTES));
    var source = String(text);
    var segments = [];
    var start = 0;

    while (start < source.length) {
        var end = windowEnd(source, start, limit);
        var cut;
        if (end >= source.length) {
            cut = source.length;
        } else {
            cut = findCut(source, start, end);
            if (cut <= start) {
                cut = avoidEntitySplit(source, start, end);
            }
            if (cut <= start) {
                cut = end > start ? end : start + 1;
            }
        }
        var piece = source.slice(start, cut).trim();
        if (piece) {
            segments.push(piece);
        }
        start = cut;
    }
    return segments;
}

// 清理控制字符 -> XML 转义 -> 分段。必须先转义再分段：字节上限针对的是实际发出去的内容。
function prepareSegments(text) {
    return splitText(escapeXml(cleanText(text)), config.MAX_SEGMENT_BYTES);
}

// ---------------------------------------------------------------- 音色与韵律

var SHORT_VOICE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9:]+){1,5}$/;
var FULL_VOICE_RE = /^Microsoft Server Speech Text to Speech Voice \([A-Za-z0-9-]+, ?[A-Za-z0-9:]+\)$/;

function isValidVoice(voice) {
    return SHORT_VOICE_RE.test(voice) || FULL_VOICE_RE.test(voice);
}

// Edge 自己发的是完整名称，这里把 zh-CN-XiaoxiaoNeural 转成
// Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)。
// 以最后一个连字符为界：zh-CN-liaoning-XiaobeiNeural 的地区是 zh-CN-liaoning。
function toVoiceName(voice) {
    if (!SHORT_VOICE_RE.test(voice)) {
        return voice;
    }
    var index = voice.lastIndexOf("-");
    return "Microsoft Server Speech Text to Speech Voice (" +
        voice.slice(0, index) + ", " + voice.slice(index + 1) + ")";
}

// 优先级：自定义音色 > 当前语言的覆盖菜单 > 全局固定音色 > 内置语言表
function resolveVoice(lang) {
    var custom = readOption("customVoice");
    if (custom) {
        return { voice: custom, source: "custom" };
    }
    var overrideOption = config.overrideOptionFor(lang);
    if (overrideOption) {
        var override = readOption(overrideOption);
        if (override && override !== config.FOLLOW_MODE) {
            return { voice: override, source: "override" };
        }
    }
    if (readOption("voiceMode") === config.VOICE_MODE_GLOBAL) {
        return { voice: readOption("globalVoice") || config.DEFAULT_GLOBAL_VOICE, source: "global" };
    }
    var builtin = config.defaultVoiceFor(lang);
    if (builtin) {
        return { voice: builtin, source: "table" };
    }
    return null;
}

function pickProsody(name, pattern, fallback) {
    var value = readOption(name);
    if (!value) {
        return fallback;
    }
    if (!pattern.test(value)) {
        logInfo("选项 " + name + " 的值无效，改用默认值 " + fallback);
        return fallback;
    }
    return value;
}

function resolveProsody() {
    return {
        rate: pickProsody("rate", /^[+-]\d{1,3}%$/, config.DEFAULT_RATE),
        pitch: pickProsody("pitch", /^[+-]\d{1,3}Hz$/, config.DEFAULT_PITCH),
        volume: pickProsody("volume", /^[+-]\d{1,3}%$/, config.DEFAULT_VOLUME)
    };
}

// ---------------------------------------------------------------- 帧解析

var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesFromHex(hex) {
    var bytes = [];
    for (var i = 0; i + 1 < hex.length; i += 2) {
        bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return bytes;
}

function bytesFromBase64(base64) {
    var bytes = [];
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < base64.length; i++) {
        var value = BASE64_CHARS.indexOf(base64.charAt(i));
        if (value < 0) {
            continue;
        }
        acc = (acc << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >>> bits) & 0xff);
            acc &= (1 << bits) - 1;
        }
    }
    return bytes;
}

// 把 Bob 的 $data 变成字节数组。真机上 $data 没有 length 属性（与文档不符），
// 所以一律先转成数组再取长度；toByteArray 不可用时退到 toHex，再退到 toBase64。
function dataToBytes(data) {
    if (!data) {
        throw new Error("收到空的二进制帧");
    }
    if (typeof data.toByteArray === "function") {
        var array = data.toByteArray();
        if (array && typeof array.length === "number") {
            return array;
        }
    }
    if (typeof data.toHex === "function") {
        var hex = data.toHex();
        if (typeof hex === "string") {
            return bytesFromHex(hex);
        }
    }
    if (typeof data.toBase64 === "function") {
        var base64 = data.toBase64();
        if (typeof base64 === "string") {
            return bytesFromBase64(base64);
        }
    }
    throw new Error("无法读取二进制帧的内容（$data 没有可用的取字节方法）");
}

function parseHeaderLines(text) {
    var headers = {};
    var lines = String(text).split("\r\n");
    for (var i = 0; i < lines.length; i++) {
        var colon = lines[i].indexOf(":");
        if (colon > 0) {
            headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
        }
    }
    return headers;
}

// 二进制帧：前 2 字节是大端整数 N，头文本占 [2, 2+N)，音频从 2+N 开始
function parseBinaryFrame(bytes) {
    if (!bytes || bytes.length < 2) {
        return { ok: false, reason: "帧长度不足 2 字节" };
    }
    var headerLength = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff);
    var audioStart = 2 + headerLength;
    if (audioStart > bytes.length) {
        return { ok: false, reason: "头长度 " + headerLength + " 超过帧长度 " + bytes.length };
    }
    var headerText = "";
    for (var i = 2; i < audioStart; i++) {
        headerText += String.fromCharCode(bytes[i] & 0xff);
    }
    var headers = parseHeaderLines(headerText);
    return {
        ok: true,
        headers: headers,
        path: headers.path || "",
        contentType: headers["content-type"] || "",
        audioStart: audioStart,
        audioLength: bytes.length - audioStart
    };
}

// 文本帧：头和正文之间隔一个空行
function parseTextFrame(text) {
    var str = String(text);
    var separator = str.indexOf("\r\n\r\n");
    var headerText = separator === -1 ? str : str.slice(0, separator);
    var headers = parseHeaderLines(headerText);
    return {
        headers: headers,
        path: headers.path || "",
        body: separator === -1 ? "" : str.slice(separator + 4)
    };
}

// 流式 base64 编码器：一帧一帧喂字节，凑不满 3 字节的留到下一帧，
// 这样多条连接的音频可以直接拼成同一个 base64 串，内存里也不用留整段原始字节。
function Base64Sink() {
    this.parts = [];
    this.carry = [];
    this.byteCount = 0;
    this.head = [];
}

function encodeTriple(b0, b1, b2) {
    return BASE64_CHARS.charAt(b0 >> 2) +
        BASE64_CHARS.charAt(((b0 & 3) << 4) | (b1 >> 4)) +
        BASE64_CHARS.charAt(((b1 & 15) << 2) | (b2 >> 6)) +
        BASE64_CHARS.charAt(b2 & 63);
}

Base64Sink.prototype.append = function (bytes, start, end) {
    var i = start;
    var chunk = "";
    this.byteCount += end - start;
    // 留下整段音频最开头的 4 个字节，合成结束后用来判断是不是 mp3
    for (var j = start; j < end && this.head.length < 4; j++) {
        this.head.push(bytes[j] & 0xff);
    }
    while (this.carry.length > 0 && this.carry.length < 3 && i < end) {
        this.carry.push(bytes[i] & 0xff);
        i += 1;
    }
    if (this.carry.length === 3) {
        chunk += encodeTriple(this.carry[0], this.carry[1], this.carry[2]);
        this.carry = [];
    }
    var full = i + Math.floor((end - i) / 3) * 3;
    for (; i < full; i += 3) {
        chunk += encodeTriple(bytes[i] & 0xff, bytes[i + 1] & 0xff, bytes[i + 2] & 0xff);
    }
    for (; i < end; i++) {
        this.carry.push(bytes[i] & 0xff);
    }
    if (chunk) {
        this.parts.push(chunk);
    }
};

Base64Sink.prototype.finish = function () {
    var tail = "";
    if (this.carry.length === 1) {
        tail = encodeTriple(this.carry[0], 0, 0).slice(0, 2) + "==";
    } else if (this.carry.length === 2) {
        tail = encodeTriple(this.carry[0], this.carry[1], 0).slice(0, 3) + "=";
    }
    this.carry = [];
    return this.parts.join("") + tail;
};

// 只用于日志：mp3 要么以 ID3 开头，要么直接是帧同步字（11 个 1）
function sniffAudio(head) {
    if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        return "mp3";
    }
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
        return "mp3";
    }
    return "unknown";
}

// ---------------------------------------------------------------- 单条连接

function describeError(error) {
    if (error === undefined || error === null) {
        return {};
    }
    if (typeof error !== "object") {
        return { message: oneLine(error) };
    }
    var out = {};
    var keys = ["code", "type", "message", "debugMessage", "localizedDescription"];
    for (var i = 0; i < keys.length; i++) {
        var value = error[keys[i]];
        if (value !== undefined && value !== null && value !== "") {
            out[keys[i]] = typeof value === "number" ? value : oneLine(value);
        }
    }
    if (!out.message) {
        out.message = oneLine(error);
    }
    return out;
}

function pickArgument(args, test) {
    for (var i = 0; i < args.length; i++) {
        if (test(args[i])) {
            return args[i];
        }
    }
    return undefined;
}

function isBinary(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    if (typeof $data !== "undefined" && $data && typeof $data.isData === "function") {
        try {
            if ($data.isData(value)) {
                return true;
            }
        } catch (ignored) {
            // 继续按鸭子类型判断
        }
    }
    return typeof value.toByteArray === "function" || typeof value.toBase64 === "function";
}

function forgetSocket(socket) {
    for (var i = activeSockets.length - 1; i >= 0; i--) {
        if (activeSockets[i] === socket) {
            activeSockets.splice(i, 1);
        }
    }
}

// 建一条连接合成一段文本。callback(failure, audio)：
//   failure = { kind, detail }，kind 取 handshake / closed / stream / timeout / noAudio / internal
//   audio   = { frames: [{ bytes, start }], bytes, textFrames, binaryFrames, ignoredFrames, ms }
// 无论事件以什么顺序到达，callback 只会被调用一次。
function connectOnce(params, callback) {
    var startedAt = nowMs();
    var finished = false;
    var opened = false;
    var socket = null;
    var timerId = null;
    var stats = { frames: [], bytes: 0, textFrames: 0, binaryFrames: 0, ignoredFrames: 0 };

    function finish(failure) {
        if (finished) {
            return;
        }
        finished = true;
        if (timerId !== null && typeof $timer !== "undefined" && $timer) {
            try {
                $timer.invalidate(timerId);
            } catch (ignored) {
                // 定时器已经触发过
            }
        }
        timerId = null;
        if (socket) {
            try {
                // 必须传一个对象：Bob 1.21.0 上不带参数的 close() 会在日志里记一条未捕获异常
                socket.close({});
            } catch (ignored2) {
                // 连接本来就没建立起来
            }
            forgetSocket(socket);
        }
        stats.ms = nowMs() - startedAt;
        if (failure) {
            failure.detail = failure.detail || {};
            failure.detail.ms = stats.ms;
            failure.detail.opened = opened;
            failure.detail.textFrames = stats.textFrames;
            failure.detail.binaryFrames = stats.binaryFrames;
            failure.detail.audioBytes = stats.bytes;
            callback(failure, null);
        } else {
            callback(null, stats);
        }
    }

    function guarded(name, handler) {
        return function () {
            if (finished) {
                return;
            }
            try {
                handler.apply(null, arguments);
            } catch (err) {
                finish({ kind: "internal", detail: { event: name, error: describeError(err) } });
            }
        };
    }

    function onOpen() {
        opened = true;
        var ms = correctedNowMs();
        socket.sendString(buildConfigMessage(ms));
        socket.sendString(buildSsmlMessage(ms, params.voiceName, params.prosody, params.text));
    }

    function onText() {
        var text = pickArgument(arguments, function (value) {
            return typeof value === "string";
        });
        if (text === undefined) {
            return;
        }
        stats.textFrames += 1;
        var frame = parseTextFrame(text);
        if (frame.path !== "turn.end") {
            return;
        }
        if (stats.bytes > 0) {
            finish(null);
        } else {
            finish({ kind: "noAudio", detail: {} });
        }
    }

    function onData() {
        var data = pickArgument(arguments, isBinary);
        if (data === undefined) {
            return;
        }
        stats.binaryFrames += 1;
        var bytes = dataToBytes(data);
        var frame = parseBinaryFrame(bytes);
        if (!frame.ok) {
            stats.ignoredFrames += 1;
            logInfo("忽略无法解析的二进制帧：" + frame.reason);
            return;
        }
        if (frame.path !== "audio") {
            stats.ignoredFrames += 1;
            logInfo("忽略 Path 不是 audio 的二进制帧：" + oneLine(frame.path, 60));
            return;
        }
        if (!frame.contentType) {
            // 结束前服务端会发一帧没有 Content-Type 也没有数据的 Path:audio，属于正常情况
            if (frame.audioLength > 0) {
                stats.ignoredFrames += 1;
                logInfo("忽略没有 Content-Type 却带了 " + frame.audioLength + " 字节数据的二进制帧");
            }
            return;
        }
        if (frame.contentType.toLowerCase().indexOf("audio/") !== 0) {
            stats.ignoredFrames += 1;
            logInfo("忽略 Content-Type 不是音频的二进制帧：" + oneLine(frame.contentType, 60));
            return;
        }
        if (frame.audioLength === 0) {
            return;
        }
        stats.frames.push({ bytes: bytes, start: frame.audioStart });
        stats.bytes += frame.audioLength;
    }

    function onError() {
        var error = pickArgument(arguments, function (value) {
            return value !== socket && value !== undefined && value !== null;
        });
        finish({ kind: opened ? "stream" : "handshake", detail: { error: describeError(error) } });
    }

    function onClose() {
        var code = pickArgument(arguments, function (value) {
            return typeof value === "number";
        });
        var reason = pickArgument(arguments, function (value) {
            return typeof value === "string";
        });
        finish({
            kind: opened ? "closed" : "handshake",
            detail: { closeCode: code === undefined ? null : code, closeReason: oneLine(reason || "") }
        });
    }

    try {
        if (typeof $websocket === "undefined" || !$websocket || typeof $websocket.new !== "function") {
            finish({ kind: "internal", detail: { error: { message: "当前 Bob 版本没有 $websocket" } } });
            return;
        }
        socket = $websocket.new({
            url: buildUrl(correctedNowMs() / 1000),
            timeoutInterval: params.timeoutSeconds,
            header: buildHeaders()
        });
        activeSockets.push(socket);

        socket.listenOpen(guarded("open", onOpen));
        socket.listenReceiveString(guarded("text", onText));
        socket.listenReceiveData(guarded("data", onData));
        socket.listenError(guarded("error", onError));
        socket.listenClose(guarded("close", onClose));

        if (typeof $timer !== "undefined" && $timer && typeof $timer.schedule === "function") {
            timerId = $timer.schedule({
                interval: params.timeoutSeconds,
                repeats: false,
                handler: function () {
                    timerId = null;
                    finish({ kind: "timeout", detail: { timeoutSeconds: params.timeoutSeconds } });
                }
            });
        }

        socket.open();
    } catch (err) {
        finish({ kind: "internal", detail: { event: "connect", error: describeError(err) } });
    }
}

// ---------------------------------------------------------------- 时钟偏差兜底

function findHeader(headers, name) {
    if (!headers || typeof headers !== "object") {
        return "";
    }
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).toLowerCase() === name) {
            return trimmed(headers[keys[i]]);
        }
    }
    return "";
}

// 解析 HTTP Date 头（RFC 7231：Sun, 27 Sep 2026 03:10:14 GMT），返回毫秒时间戳或 NaN
function parseHttpDate(value) {
    var match = /^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/
        .exec(trimmed(value));
    if (!match) {
        return NaN;
    }
    var month = MONTH_NAMES.indexOf(match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase());
    if (month < 0) {
        return NaN;
    }
    return Date.UTC(Number(match[3]), month, Number(match[1]),
        Number(match[4]), Number(match[5]), Number(match[6]));
}

// 握手被拒时拿不到响应头，改为请求音色列表，用它的 Date 头估算本机时钟偏差。
// callback({ reachable, skewMs, serverDate, statusCode, error })
function probeClockSkew(callback) {
    var done = once(callback, "时钟探测");
    var sentAt = nowMs();

    if (typeof $http === "undefined" || !$http || typeof $http.request !== "function") {
        done({ reachable: false, error: { message: "当前 Bob 版本没有 $http" } });
        return;
    }
    try {
        $http.request({
            method: "GET",
            url: config.VOICE_LIST_URL,
            header: {
                "User-Agent": config.USER_AGENT,
                "Accept-Language": config.ACCEPT_LANGUAGE
            },
            timeout: SKEW_PROBE_TIMEOUT,
            handler: function (resp) {
                var receivedAt = nowMs();
                var response = resp && resp.response;
                if (!resp || resp.error || !response) {
                    done({ reachable: false, error: describeError(resp && resp.error) });
                    return;
                }
                var serverDate = findHeader(response.headers, "date");
                var serverMs = parseHttpDate(serverDate);
                var result = {
                    reachable: true,
                    statusCode: Number(response.statusCode) || 0,
                    serverDate: serverDate
                };
                if (!isNaN(serverMs)) {
                    // 以请求往返的中点作为本机时间
                    result.skewMs = Math.round(serverMs - (sentAt + receivedAt) / 2);
                }
                done(result);
            }
        });
    } catch (err) {
        done({ reachable: false, error: describeError(err) });
    }
}

// ---------------------------------------------------------------- 错误映射

// Bob 的文档先后用过两种拼写（addtion / addition、unsupportLanguage / unsupportedLanguage），
// 新版 Bob 两种都认。类型用各版本都认的旧拼写，附加信息两个键都填。
function makeError(type, message, detail) {
    return { type: type, message: message, addtion: detail, addition: detail };
}

function failureToError(failure, context) {
    var detail = {};
    var source = failure.detail || {};
    Object.keys(source).forEach(function (key) {
        detail[key] = source[key];
    });
    detail.kind = failure.kind;
    detail.voice = context.voice;
    detail.segment = context.segmentIndex + 1;
    detail.segments = context.segmentCount;
    if (context.skew) {
        detail.clockProbe = context.skew;
    }

    if (failure.kind === "handshake") {
        return makeError("api", MESSAGE_REJECTED, detail);
    }
    if (failure.kind === "noAudio") {
        return makeError("api", MESSAGE_NO_AUDIO, detail);
    }
    if (failure.kind === "timeout") {
        return makeError("network",
            "连接微软语音服务超时（" + source.timeoutSeconds + " 秒内没有合成完），请检查网络后重试", detail);
    }
    if (failure.kind === "closed") {
        if (/unsupported voice/i.test(source.closeReason || "")) {
            return makeError("param",
                "音色 " + context.voice + " 不存在或已下线，请在插件设置里换一个音色", detail);
        }
        return makeError("api",
            "微软接口中途关闭了连接" + (source.closeReason ? "：" + source.closeReason : "") + "，请稍后重试",
            detail);
    }
    if (failure.kind === "stream") {
        return makeError("network", "与微软语音服务的连接中断，请检查网络后重试", detail);
    }
    return makeError("unknown",
        "语音合成失败：" + ((source.error && source.error.message) || "插件内部错误"), detail);
}

// ---------------------------------------------------------------- 合成

// 合成一段。握手被拒时测一次时钟偏差、重签、再试一次；整次朗读只兜底一次。
function synthesizeSegment(job, index, callback) {
    var context = {
        voice: job.voice,
        segmentIndex: index,
        segmentCount: job.segments.length
    };

    function attempt() {
        var remainingMs = job.deadline - nowMs();
        if (remainingMs <= 0) {
            callback(makeError("network",
                "文本较长，" + Math.round(job.budgetMs / 1000) + " 秒内没有合成完，请分几次朗读",
                { kind: "budget", voice: job.voice, segment: index + 1, segments: job.segments.length }));
            return;
        }
        connectOnce({
            voiceName: job.voiceName,
            prosody: job.prosody,
            text: job.segments[index],
            timeoutSeconds: Math.max(1, Math.min(CONNECT_TIMEOUT, Math.ceil(remainingMs / 1000)))
        }, function (failure, audio) {
            if (!failure) {
                callback(null, audio);
                return;
            }
            if (failure.kind !== "handshake" || job.skewProbed) {
                callback(failureToError(failure, context));
                return;
            }
            job.skewProbed = true;
            logInfo("握手失败，检查本机时钟后重试一次 detail=" + oneLine(JSON.stringify(failure.detail)));
            probeClockSkew(function (probe) {
                context.skew = probe;
                if (!probe.reachable) {
                    var detail = failure.detail || {};
                    detail.kind = "unreachable";
                    detail.voice = job.voice;
                    detail.clockProbe = probe;
                    callback(makeError("network", "连接不上微软语音服务，请检查网络或代理设置", detail));
                    return;
                }
                if (typeof probe.skewMs === "number") {
                    clockSkewMs = probe.skewMs;
                    logInfo("本机时钟与服务器相差 " + Math.round(probe.skewMs / 1000) + " 秒，已按服务器时间重新签名");
                } else {
                    logInfo("音色列表接口没有返回可用的 Date 头，按原时间重试一次");
                }
                attempt();
            });
        });
    }

    attempt();
}

// request = { text, lang, voice: { voice, source }, budgetMs }
// callback(error, { base64, bytes, segments, ms, format })
function synthesize(request, callback) {
    var startedAt = nowMs();
    var voice = request.voice.voice;

    if (!isValidVoice(voice)) {
        callback(makeError("param",
            "音色名称格式无效：" + oneLine(voice, 80) + "。应形如 zh-CN-XiaoxiaoNeural",
            { voice: voice, source: request.voice.source }));
        return;
    }

    var segments = prepareSegments(request.text);
    if (!segments.length) {
        callback(makeError("param", "没有可朗读的文本", { chars: String(request.text || "").length }));
        return;
    }

    var job = {
        voice: voice,
        voiceName: toVoiceName(voice),
        prosody: resolveProsody(),
        segments: segments,
        budgetMs: request.budgetMs,
        deadline: startedAt + request.budgetMs,
        skewProbed: false
    };
    var sink = new Base64Sink();
    var index = 0;

    function fail(error) {
        logError("failed type=" + error.type +
            " kind=" + ((error.addtion && error.addtion.kind) || "-") +
            " voice=" + voice + "(" + request.voice.source + ")" +
            " segment=" + (index + 1) + "/" + segments.length +
            " ms=" + (nowMs() - startedAt) +
            " detail=" + oneLine(JSON.stringify(error.addtion || {}), 500));
        callback(error, null);
    }

    function next() {
        if (index >= segments.length) {
            var format = sniffAudio(sink.head);
            var base64 = sink.finish();
            var ms = nowMs() - startedAt;
            if (format === "unknown") {
                logInfo("warn 返回的数据开头不像 mp3，仍交给 Bob 播放");
            }
            logInfo("done voice=" + voice + "(" + request.voice.source + ")" +
                " lang=" + (request.lang || "-") +
                " segments=" + segments.length +
                " bytes=" + sink.byteCount +
                " ms=" + ms +
                " rate=" + job.prosody.rate + " pitch=" + job.prosody.pitch + " volume=" + job.prosody.volume);
            callback(null, {
                base64: base64,
                bytes: sink.byteCount,
                segments: segments.length,
                ms: ms,
                format: format,
                prosody: job.prosody
            });
            return;
        }
        synthesizeSegment(job, index, function (error, audio) {
            if (error) {
                fail(error);
                return;
            }
            for (var i = 0; i < audio.frames.length; i++) {
                var frame = audio.frames[i];
                sink.append(frame.bytes, frame.start, frame.bytes.length);
            }
            index += 1;
            next();
        });
    }

    next();
}

function unexpectedError(err) {
    var detail = describeError(err);
    return makeError("unknown", "语音合成失败：" + (detail.message || "插件内部错误"), detail);
}

// ---------------------------------------------------------------- 插件接口

function supportLanguages() {
    return config.supportedLanguages();
}

function pluginTimeoutInterval() {
    return PLUGIN_TIMEOUT_INTERVAL;
}

function tts(query, completion) {
    var done = once(completion, "tts completion");
    try {
        var text = query && typeof query.text === "string" ? query.text : "";
        var lang = query && query.lang ? String(query.lang) : "";

        if (!text.trim()) {
            done({ error: makeError("param", "没有可朗读的文本", { chars: text.length }) });
            return;
        }
        var voice = resolveVoice(lang);
        if (!voice) {
            done({
                error: makeError("unsupportLanguage",
                    "暂不支持朗读这种语言（" + (lang || "未知") + "）。可以在插件设置里填写自定义音色，或把音色模式改为全局固定",
                    { lang: lang })
            });
            return;
        }

        synthesize({ text: text, lang: lang, voice: voice, budgetMs: TOTAL_BUDGET_MS }, function (error, out) {
            if (error) {
                done({ error: error });
                return;
            }
            done({
                result: {
                    type: "base64",
                    value: out.base64,
                    raw: {
                        voice: voice.voice,
                        voice_source: voice.source,
                        segments: out.segments,
                        bytes: out.bytes,
                        ms: out.ms,
                        format: out.format,
                        prosody: out.prosody
                    }
                }
            });
        });
    } catch (err) {
        logError("tts 抛出异常：" + oneLine(err));
        done({ error: unexpectedError(err) });
    }
}

// 验证用的文本只有两个字，尽量用音色自己的语言：英文音色读不了中文，会得到「未返回音频」
function validationSample(voice) {
    return /^(zh|yue|wuu)-|\(zh-/i.test(voice) ? "你好" : "Hi";
}

// 用当前设置下会用到的音色真实合成两个字。按语言自动时拿简体中文那一路来验证。
function pluginValidate(completion) {
    var done = once(completion, "validate completion");
    try {
        var voice = resolveVoice("zh-Hans");
        synthesize({
            text: validationSample(voice.voice),
            lang: "",
            voice: voice,
            budgetMs: VALIDATE_BUDGET_MS
        }, function (error) {
            if (error) {
                done({ result: false, error: error });
            } else {
                done({ result: true });
            }
        });
    } catch (err) {
        logError("pluginValidate 抛出异常：" + oneLine(err));
        done({ result: false, error: unexpectedError(err) });
    }
}

exports.supportLanguages = supportLanguages;
exports.pluginTimeoutInterval = pluginTimeoutInterval;
exports.pluginValidate = pluginValidate;
exports.tts = tts;

// 仅供 scripts/test_plugin.js 做单元测试，Bob 不会用到
exports.__test = {
    sha256Hex: sha256Hex,
    gecPayload: gecPayload,
    secMsGec: secMsGec,
    connectionId: connectionId,
    randomHex: randomHex,
    buildUrl: buildUrl,
    buildHeaders: buildHeaders,
    timestampString: timestampString,
    buildConfigMessage: buildConfigMessage,
    buildSsml: buildSsml,
    buildSsmlMessage: buildSsmlMessage,
    cleanText: cleanText,
    escapeXml: escapeXml,
    utf8Length: utf8Length,
    splitText: splitText,
    prepareSegments: prepareSegments,
    isValidVoice: isValidVoice,
    toVoiceName: toVoiceName,
    resolveVoice: resolveVoice,
    resolveProsody: resolveProsody,
    dataToBytes: dataToBytes,
    parseBinaryFrame: parseBinaryFrame,
    parseTextFrame: parseTextFrame,
    parseHttpDate: parseHttpDate,
    Base64Sink: Base64Sink,
    validationSample: validationSample,
    getClockSkewMs: function () {
        return clockSkewMs;
    },
    setClockSkewMs: function (value) {
        clockSkewMs = value;
    },
    activeSocketCount: function () {
        return activeSockets.length;
    }
};
