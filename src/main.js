var config = require("./config.js");
var sha256 = require("./sha256.js");
var textUtil = require("./text.js");

var LOG_TAG = "[edge-tts]";

// Bob 宿主超时。插件自己的总预算必须更短，才有机会把明确的错误交回 Bob。
var PLUGIN_TIMEOUT_INTERVAL = 60;
var TOTAL_BUDGET_MS = 55000;
var VALIDATE_BUDGET_MS = 25000;
// 每条 WebSocket 连接的超时。真机实测（docs/poc-findings.md）：连接被拒、域名解析失败、
// TCP 被掐断、握手后服务端不吭声，这几种情况 Bob 都不给任何回调，timeoutInterval 也不起作用，
// 所以三个超时都由插件自己的看门狗负责。
// 单条连接从发起到 turn.end 的上限
var CONNECT_TIMEOUT = 30;
// 握手的上限。正常握手不到 1 秒
var OPEN_TIMEOUT = 10;
// 握手之后连续收不到任何帧的上限。微软是一口气把音频推完的，帧与帧之间只隔几毫秒
var IDLE_TIMEOUT = 15;
var SKEW_PROBE_TIMEOUT = 10;
// 瞬时故障（服务端 5xx、中途关闭、断流、连上后没数据）整次朗读最多再试这么多次；
// 剩余预算不足 RETRY_MIN_REMAINING_MS 就不再重试，直接把错误交回 Bob
var MAX_TRANSIENT_RETRIES = 2;
var RETRY_MIN_REMAINING_MS = 5000;

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
//   failure = { kind, detail }，kind 取 handshake / connectTimeout / closed / stream / stalled /
//             timeout / noAudio / internal
//   audio   = { frames: [{ bytes, start }], bytes, textFrames, binaryFrames, ignoredFrames, ms }
// 无论事件以什么顺序到达，callback 只会被调用一次。
function connectOnce(params, callback) {
    var startedAt = nowMs();
    var lastActivityAt = startedAt;
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

    // 看门狗：一次只挂一个不重复的定时器，到点后看哪条期限到了；都没到就按最近的期限重新上弦。
    // 收到帧时只更新 lastActivityAt，不去动定时器。
    function deadlines() {
        var overall = startedAt + params.timeoutSeconds * 1000;
        var phase = opened ? lastActivityAt + IDLE_TIMEOUT * 1000 : startedAt + OPEN_TIMEOUT * 1000;
        return { overall: overall, phase: phase, next: Math.min(overall, phase) };
    }

    function armWatchdog() {
        if (typeof $timer === "undefined" || !$timer || typeof $timer.schedule !== "function") {
            return;
        }
        timerId = $timer.schedule({
            interval: Math.max(0.05, (deadlines().next - nowMs()) / 1000),
            repeats: false,
            handler: onWatchdog
        });
    }

    function onWatchdog() {
        timerId = null;
        if (finished) {
            return;
        }
        var now = nowMs();
        var limit = deadlines();
        if (now >= limit.overall) {
            finish({ kind: "timeout", detail: { timeoutSeconds: params.timeoutSeconds } });
        } else if (now < limit.phase) {
            armWatchdog();
        } else if (opened) {
            finish({ kind: "stalled", detail: { idleSeconds: IDLE_TIMEOUT } });
        } else {
            finish({ kind: "connectTimeout", detail: { openTimeoutSeconds: OPEN_TIMEOUT } });
        }
    }

    function onOpen() {
        opened = true;
        lastActivityAt = nowMs();
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
        lastActivityAt = nowMs();
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
        lastActivityAt = nowMs();
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

        armWatchdog();
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
    if (typeof context.retries === "number") {
        detail.retries = context.retries;
    }

    if (failure.kind === "handshake") {
        return makeError("api", MESSAGE_REJECTED, detail);
    }
    if (failure.kind === "noAudio") {
        return makeError("api", MESSAGE_NO_AUDIO, detail);
    }
    if (failure.kind === "connectTimeout") {
        return makeError("network",
            "连接不上微软语音服务（握手 " + source.openTimeoutSeconds + " 秒内没有完成），请检查网络或代理设置",
            detail);
    }
    if (failure.kind === "stalled") {
        return makeError("network",
            "与微软语音服务的连接中断（" + source.idleSeconds + " 秒没有收到数据），请检查网络后重试", detail);
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

// Bob 的 error.code 恒为 0，HTTP 状态码只出现在 message 里（如 notAnUpgrade(503)），两处都看
function isServerError(error) {
    if (!error) {
        return false;
    }
    if (typeof error.code === "number" && error.code >= 500 && error.code <= 599) {
        return true;
    }
    return /\b5\d\d\b/.test(String(error.message || ""));
}

// 换条连接再试就可能成功的故障：服务端 5xx、中途关闭（音色不存在除外）、断流、连上后没数据。
// 握手 403、连不上、总超时和插件内部错误重试也没用，不算。
function isTransientFailure(failure) {
    var detail = failure.detail || {};
    if (failure.kind === "stream" || failure.kind === "stalled") {
        return true;
    }
    if (failure.kind === "closed") {
        return !/unsupported voice/i.test(detail.closeReason || "");
    }
    if (failure.kind === "handshake") {
        return isServerError(detail.error);
    }
    return false;
}

// 合成一段。失败时按顺序兜底：握手被拒先校时重签一次（整次朗读只做一次）；音色读不了这种
// 语言就换成该语言的内置默认音色；瞬时故障最多再试 MAX_TRANSIENT_RETRIES 次。
// 每次重试都要求剩余预算还够，不然直接报错，免得撞上 Bob 的超时。
function synthesizeSegment(job, index, callback) {
    var context = {
        voice: job.voice,
        segmentIndex: index,
        segmentCount: job.segments.length
    };
    var position = "第 " + (index + 1) + "/" + job.segments.length + " 段";

    function fail(failure) {
        context.voice = job.voice;
        context.retries = job.retries;
        callback(failureToError(failure, context));
    }

    function retry(reason) {
        job.retries += 1;
        logInfo(position + " " + reason + "，第 " + job.retries + " 次重试");
        attempt();
    }

    function attempt() {
        var remainingMs = job.deadline - nowMs();
        if (remainingMs <= 0) {
            callback(makeError("network",
                "文本较长，" + Math.round(job.budgetMs / 1000) + " 秒内没有合成完，请分几次朗读",
                { kind: "budget", voice: job.voice, segment: index + 1, segments: job.segments.length,
                    retries: job.retries }));
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
            if (failure.kind === "handshake" && !job.skewProbed) {
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
                return;
            }
            var canRetry = job.deadline - nowMs() >= RETRY_MIN_REMAINING_MS;
            if (failure.kind === "noAudio" && job.fallbackVoice && canRetry) {
                var fallbackVoice = job.fallbackVoice;
                job.fallbackVoice = "";
                job.voice = fallbackVoice;
                job.voiceName = toVoiceName(fallbackVoice);
                job.voiceSource = "fallback";
                retry("音色 " + context.voice + " 读 " + (job.lang || "这种语言") + " 未返回音频，改用默认音色 " + fallbackVoice);
                return;
            }
            if (failure.kind === "noAudio" && !job.noAudioRetried && canRetry) {
                job.noAudioRetried = true;
                retry("未返回音频");
                return;
            }
            if (isTransientFailure(failure) && job.transientRetries < MAX_TRANSIENT_RETRIES && canRetry) {
                job.transientRetries += 1;
                retry(failure.kind + " 失败 detail=" + oneLine(JSON.stringify(failure.detail), 200));
                return;
            }
            fail(failure);
        });
    }

    attempt();
}

// request = { text, lang, voice: { voice, source }, budgetMs }
// callback(error, { base64, voice, voiceSource, retries, bytes, segments, ms, format, prosody })
function synthesize(request, callback) {
    var startedAt = nowMs();
    var voice = request.voice.voice;

    if (!isValidVoice(voice)) {
        callback(makeError("param",
            "音色名称格式无效：" + oneLine(voice, 80) + "。应形如 zh-CN-XiaoxiaoNeural",
            { voice: voice, source: request.voice.source }));
        return;
    }

    var segments = textUtil.prepareSegments(request.text);
    if (!segments.length) {
        callback(makeError("param", "没有可朗读的文本", { chars: String(request.text || "").length }));
        return;
    }

    var fallback = config.defaultVoiceFor(request.lang);
    var job = {
        voice: voice,
        voiceName: toVoiceName(voice),
        voiceSource: request.voice.source,
        lang: request.lang,
        // 音色读不了当前语言时改用的内置默认音色；本来就是默认音色的话没有可回退的
        fallbackVoice: fallback && fallback !== voice ? fallback : "",
        prosody: resolveProsody(),
        segments: segments,
        budgetMs: request.budgetMs,
        deadline: startedAt + request.budgetMs,
        skewProbed: false,
        noAudioRetried: false,
        transientRetries: 0,
        retries: 0
    };
    var sink = new Base64Sink();
    var index = 0;

    function fail(error) {
        logError("failed type=" + error.type +
            " kind=" + ((error.addtion && error.addtion.kind) || "-") +
            " voice=" + job.voice + "(" + job.voiceSource + ")" +
            " segment=" + (index + 1) + "/" + segments.length +
            " retries=" + job.retries +
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
            logInfo("done voice=" + job.voice + "(" + job.voiceSource + ")" +
                " lang=" + (request.lang || "-") +
                " segments=" + segments.length +
                " retries=" + job.retries +
                " bytes=" + sink.byteCount +
                " ms=" + ms +
                " rate=" + job.prosody.rate + " pitch=" + job.prosody.pitch + " volume=" + job.prosody.volume);
            callback(null, {
                base64: base64,
                voice: job.voice,
                voiceSource: job.voiceSource,
                retries: job.retries,
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
                        voice: out.voice,
                        voice_source: out.voiceSource,
                        retries: out.retries,
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
    sha256Hex: sha256.sha256Hex,
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
    cleanText: textUtil.cleanText,
    escapeXml: textUtil.escapeXml,
    splitText: textUtil.splitText,
    prepareSegments: textUtil.prepareSegments,
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
