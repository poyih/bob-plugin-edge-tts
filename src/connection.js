// 单条连接、连接看门狗与可取消的校时请求；持有宿主回调所需的连接引用。
var config = require("./config.js");
var protocol = require("./protocol.js");
var utils = require("./utils.js");
var nowMs = utils.nowMs;
var trimmed = utils.trimmed;
var oneLine = utils.oneLine;
var logInfo = utils.logInfo;
var describeError = utils.describeError;
var buildUrl = protocol.buildUrl;
var buildHeaders = protocol.buildHeaders;
var buildConfigMessage = protocol.buildConfigMessage;
var buildSsmlMessage = protocol.buildSsmlMessage;
var dataToBytes = protocol.dataToBytes;
var parseBinaryFrame = protocol.parseBinaryFrame;
var parseTextFrame = protocol.parseTextFrame;
var parseHttpDate = protocol.parseHttpDate;

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

// 本机时钟与微软服务器的偏差（毫秒）。握手被拒后测一次，之后的签名都带上它；
// Bob 不重载插件就一直有效。
var clockSkewMs = 0;

// 进行中的连接。Bob 的回调由原生侧持有，这里再留一份引用，避免合成途中 socket 被回收。
var activeSockets = [];

function correctedNowMs() {
    return nowMs() + clockSkewMs;
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
//             timeout / noAudio / internal / cancelled
//   audio   = { frames: [{ bytes, start }], bytes, textFrames, binaryFrames, ignoredFrames, ms }
// params.onFirstAudio 可选：收到第一帧音频时调用一次，这时签名和音色都已经确认没问题。
// 返回 { cancel }：取消后关闭连接，callback 收到 kind 为 cancelled 的失败；已经结束的连接取消了也没事。
// 无论事件以什么顺序到达，callback 只会被调用一次。
function connectOnce(params, callback) {
    var startedAt = nowMs();
    var lastActivityAt = startedAt;
    var finished = false;
    var opened = false;
    var audioNotified = false;
    var socket = null;
    var timerId = null;
    var stats = { frames: [], bytes: 0, textFrames: 0, binaryFrames: 0, ignoredFrames: 0 };
    var handle = {
        cancel: function () {
            finish({ kind: "cancelled", detail: {} });
        }
    };

    function finish(failure) {
        if (finished) {
            return;
        }
        finished = true;
        handle.cancel = function () {};
        if (timerId !== null && typeof $timer !== "undefined" && $timer) {
            try {
                $timer.invalidate(timerId);
            } catch (ignored) {
                // 定时器已经触发过
            }
        }
        timerId = null;
        if (socket) {
            var closingSocket = socket;
            socket = null;
            try {
                // 必须传一个对象：Bob 1.21.0 上不带参数的 close() 会在日志里记一条未捕获异常
                closingSocket.close({});
            } catch (ignored2) {
                // 连接本来就没建立起来
            }
            forgetSocket(closingSocket);
        }
        // 原生侧可能暂时保留监听回调，不能让这些闭包继续引用已完成的音频。
        var audio = stats;
        stats = null;
        params = null;
        var done = callback;
        callback = null;
        audio.ms = nowMs() - startedAt;
        if (failure) {
            failure.detail = failure.detail || {};
            failure.detail.ms = audio.ms;
            failure.detail.opened = opened;
            failure.detail.textFrames = audio.textFrames;
            failure.detail.binaryFrames = audio.binaryFrames;
            failure.detail.audioBytes = audio.bytes;
            audio.frames.length = 0;
            done(failure, null);
        } else {
            done(null, audio);
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
        if (!audioNotified) {
            audioNotified = true;
            if (typeof params.onFirstAudio === "function") {
                params.onFirstAudio();
            }
        }
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
            return handle;
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
    return handle;
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

// 握手被拒时拿不到响应头，改为请求音色列表，用它的 Date 头估算本机时钟偏差。
// 列表有 171 KB 且服务端不压缩，但只在握手被拒时才请求一次。没有改用 HEAD：2026-09-28 实测
// 这个地址对 HEAD 回 404（虽然带 Date），耗时和 GET 一样约 0.6 秒，不值得依赖一个 404。
// callback({ reachable, skewMs, serverDate, statusCode, error })
function probeClockSkew(remainingMs, callback) {
    var sentAt = nowMs();
    var timeoutMs = Math.min(SKEW_PROBE_TIMEOUT * 1000, remainingMs);
    var deadline = sentAt + timeoutMs;
    var finished = false;
    var timerId = null;
    var signal = null;
    var handle = { cancel: function () {
        finish({ reachable: false, cancelled: true }, true);
    } };

    function finish(result, cancelRequest) {
        if (finished) {
            return;
        }
        finished = true;
        if (timerId !== null) {
            try { $timer.invalidate(timerId); } catch (ignored) {}
            timerId = null;
        }
        if (cancelRequest && signal && typeof signal.send === "function") {
            try { signal.send(); } catch (ignored2) {}
        }
        var done = callback;
        callback = null;
        signal = null;
        done(result);
    }

    function armWatchdog() {
        if (typeof $timer === "undefined" || !$timer || typeof $timer.schedule !== "function") {
            return;
        }
        timerId = $timer.schedule({
            interval: Math.max(0.001, (deadline - nowMs()) / 1000),
            repeats: false,
            handler: function () {
                timerId = null;
                if (finished) { return; }
                if (nowMs() < deadline) {
                    armWatchdog();
                } else {
                    finish({ reachable: false, error: { message: "校时请求超时" } }, true);
                }
            }
        });
    }

    if (typeof $http === "undefined" || !$http || typeof $http.request !== "function") {
        finish({ reachable: false, error: { message: "当前 Bob 版本没有 $http" } });
        return handle;
    }
    try {
        if (typeof $signal !== "undefined" && $signal && typeof $signal.new === "function") {
            signal = $signal.new();
        }
        armWatchdog();
        $http.request({
            method: "GET",
            url: config.VOICE_LIST_URL,
            header: {
                "User-Agent": config.USER_AGENT,
                "Accept-Language": config.ACCEPT_LANGUAGE
            },
            timeout: timeoutMs / 1000,
            cancelSignal: signal || undefined,
            handler: function (resp) {
                if (finished) { return; }
                var receivedAt = nowMs();
                if (receivedAt >= deadline) {
                    finish({ reachable: false, error: { message: "校时请求超时" } }, true);
                    return;
                }
                var response = resp && resp.response;
                if (!resp || resp.error || !response) {
                    finish({ reachable: false, error: describeError(resp && resp.error) });
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
                finish(result);
            }
        });
    } catch (err) {
        finish({ reachable: false, error: describeError(err) }, true);
    }
    return handle;
}

exports.connectOnce = connectOnce;
exports.probeClockSkew = probeClockSkew;
exports.CONNECT_TIMEOUT = CONNECT_TIMEOUT;
exports.getClockSkewMs = function () { return clockSkewMs; };
exports.setClockSkewMs = function (value) { clockSkewMs = value; };
exports.activeSocketCount = function () { return activeSockets.length; };
