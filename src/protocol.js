// Edge 签名、消息构造、帧解析与音频编码；不管理网络或任务状态。
var config = require("./config.js");
var sha256 = require("./sha256.js");
var trimmed = require("./utils.js").trimmed;

// ---------------------------------------------------------------- 签名与握手参数

// Sec-MS-GEC 的待哈希字串：FILETIME 刻度（100 纳秒）向下取整到 5 分钟，再拼 TrustedClientToken。
// 秒数乘 10^7 会超过 2^53，所以用整数秒的十进制串后面直接补 7 个 0，不做浮点乘法。
function gecPayload(unixSeconds) {
    var seconds = Math.floor(Number(unixSeconds)) + config.WIN_EPOCH_SECONDS;
    seconds = Math.floor(seconds / config.GEC_WINDOW_SECONDS) * config.GEC_WINDOW_SECONDS;
    return String(seconds) + "0000000" + config.TRUSTED_CLIENT_TOKEN;
}

function secMsGec(unixSeconds) {
    return sha256.sha256Hex(gecPayload(unixSeconds)).toUpperCase();
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

exports.gecPayload = gecPayload;
exports.secMsGec = secMsGec;
exports.randomHex = randomHex;
exports.connectionId = connectionId;
exports.buildUrl = buildUrl;
exports.buildHeaders = buildHeaders;
exports.timestampString = timestampString;
exports.buildConfigMessage = buildConfigMessage;
exports.buildSsml = buildSsml;
exports.buildSsmlMessage = buildSsmlMessage;
exports.dataToBytes = dataToBytes;
exports.parseBinaryFrame = parseBinaryFrame;
exports.parseTextFrame = parseTextFrame;
exports.parseHttpDate = parseHttpDate;
exports.Base64Sink = Base64Sink;
exports.sniffAudio = sniffAudio;
exports.sha256Hex = sha256.sha256Hex;
