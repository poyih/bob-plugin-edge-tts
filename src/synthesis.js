// 整次朗读的预算、重试、音色回退、并发调度与按序拼接。
var config = require("./config.js");
var textUtil = require("./text.js");
var protocol = require("./protocol.js");
var transport = require("./connection.js");
var voiceOptions = require("./options.js");
var utils = require("./utils.js");
var nowMs = utils.nowMs;
var oneLine = utils.oneLine;
var logInfo = utils.logInfo;
var logError = utils.logError;
var makeError = utils.makeError;
var isValidVoice = voiceOptions.isValidVoice;
var toVoiceName = voiceOptions.toVoiceName;
var resolveProsody = voiceOptions.resolveProsody;
var Base64Sink = protocol.Base64Sink;
var sniffAudio = protocol.sniffAudio;
var connectOnce = transport.connectOnce;
var probeClockSkew = transport.probeClockSkew;
var CONNECT_TIMEOUT = transport.CONNECT_TIMEOUT;

// 瞬时故障（服务端 5xx、中途关闭、断流、连上后没数据）整次朗读最多再试这么多次；
// 剩余预算不足 RETRY_MIN_REMAINING_MS 就不再重试，直接把错误交回 Bob
var MAX_TRANSIENT_RETRIES = 2;
var RETRY_MIN_REMAINING_MS = 5000;

var MESSAGE_REJECTED = "微软接口拒绝连接，请检查系统时间；若持续失败请更新插件";
var MESSAGE_NO_AUDIO = "未返回音频，请换个音色重试";

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
// 语言就换成该语言的内置默认音色；瞬时故障最多再试 MAX_TRANSIENT_RETRIES 次。重试次数与回退
// 在整次朗读的各段之间共用。每次重试都要求剩余预算还够，不然直接报错，免得撞上 Bob 的超时。
// job.stopped 之后（别的段已经失败）不再发起连接，也不再回调。
function synthesizeSegment(job, index, callback, onFirstAudio) {
    var generation = job.generation;
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
        if (job.stopped || generation !== job.generation) {
            return;
        }
        var remainingMs = job.deadline - nowMs();
        if (remainingMs <= 0) {
            callback(makeError("network",
                "文本较长，" + Math.round(job.budgetMs / 1000) + " 秒内没有合成完，请分几次朗读",
                { kind: "budget", voice: job.voice, segment: index + 1, segments: job.segments.length,
                    retries: job.retries }));
            return;
        }
        // 先登记占位：同步回调可能结束连接或换音色，返回后不再把已完成句柄放回列表。
        var connection = null;
        var connectionRecord = { cancel: function () {
            if (connection) { connection.cancel(); }
        } };
        job.connections.push(connectionRecord);
        connection = connectOnce({
            voiceName: job.voiceName,
            prosody: job.prosody,
            text: job.segments[index],
            timeoutSeconds: Math.max(1, Math.min(CONNECT_TIMEOUT, Math.ceil(remainingMs / 1000))),
            onFirstAudio: function () {
                if (!job.stopped && generation === job.generation) { onFirstAudio(); }
            }
        }, function (failure, audio) {
            var at = job.connections.indexOf(connectionRecord);
            if (at !== -1) { job.connections.splice(at, 1); }
            if (job.stopped || generation !== job.generation) {
                if (audio) { audio.frames.length = 0; }
                return;
            }
            if (job.expired(index)) {
                return;
            }
            if (!failure) {
                callback(null, audio);
                return;
            }
            if (failure.kind === "handshake" && !job.skewProbed) {
                job.skewProbed = true;
                logInfo("握手失败，检查本机时钟后重试一次 detail=" + oneLine(JSON.stringify(failure.detail)));
                var probeRecord = { cancel: function () {} };
                job.probes.push(probeRecord);
                var probeHandle = probeClockSkew(job.deadline - nowMs(), function (probe) {
                    var at = job.probes.indexOf(probeRecord);
                    if (at !== -1) { job.probes.splice(at, 1); }
                    if (job.stopped || generation !== job.generation) {
                        return;
                    }
                    if (job.expired(index)) {
                        return;
                    }
                    context.skew = probe;
                    if (!probe.reachable) {
                        var detail = failure.detail || {};
                        detail.kind = "unreachable";
                        detail.voice = job.voice;
                        detail.segment = index + 1;
                        detail.segments = job.segments.length;
                        detail.clockProbe = probe;
                        callback(makeError("network", "连接不上微软语音服务，请检查网络或代理设置", detail));
                        return;
                    }
                    if (typeof probe.skewMs === "number") {
                        transport.setClockSkewMs(probe.skewMs);
                        logInfo("本机时钟与服务器相差 " + Math.round(probe.skewMs / 1000) + " 秒，已按服务器时间重新签名");
                    } else {
                        logInfo("音色列表接口没有返回可用的 Date 头，按原时间重试一次");
                    }
                    attempt();
                });
                probeRecord.cancel = probeHandle.cancel;
                if (job.stopped || generation !== job.generation) { probeHandle.cancel(); }
                return;
            }
            var canRetry = job.deadline - nowMs() >= RETRY_MIN_REMAINING_MS;
            if (failure.kind === "noAudio" && job.fallbackVoice && canRetry) {
                job.restartWithFallback(index, context.voice);
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
        // 同步回调可能已经结束任务或换了音色，旧轮次的连接不能登记到新轮次。
        if (job.stopped || generation !== job.generation) {
            connection.cancel();
        }
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
        retries: 0,
        // 回退音色时递增，旧轮次的异步回调不再影响当前结果。
        generation: 0,
        // 某一段最终失败后置位：其余段的连接全部取消，不再重试，也不再回调
        stopped: false,
        // 只持有尚未结束的连接，完成回调会立即移除对应记录。
        connections: [],
        probes: []
    };
    var sink = new Base64Sink();
    var parallel = Math.max(1, Math.floor(Number(config.PARALLEL_SEGMENTS) || 1));
    // 已合成、还没轮到拼进 sink 的段
    var pending = [];
    // 已经按段序拼进 sink 的段数
    var flushed = 0;
    // 已经启动的段数
    var started = 0;
    // 第 1 段收到第一帧音频之前，后面的段不启动：握手被拒要先校时，音色读不了这种语言要先换音色
    var gateOpen = false;
    var budgetTimerId = null;

    function clearBudgetTimer() {
        if (budgetTimerId !== null) {
            try { $timer.invalidate(budgetTimerId); } catch (ignored) {}
            budgetTimerId = null;
        }
    }

    function cancelProbes() {
        var probes = job.probes;
        job.probes = [];
        for (var i = 0; i < probes.length; i++) { probes[i].cancel(); }
    }

    function cancelConnections() {
        var connections = job.connections;
        job.connections = [];
        for (var i = 0; i < connections.length; i++) { connections[i].cancel(); }
    }

    function discardAudio() {
        for (var i = 0; i < pending.length; i++) {
            if (pending[i]) { pending[i].frames.length = 0; }
        }
        pending = [];
        sink = new Base64Sink();
    }

    job.restartWithFallback = function (index, previousVoice) {
        var fallbackVoice = job.fallbackVoice;
        job.fallbackVoice = "";
        job.generation += 1;
        cancelProbes();
        cancelConnections();
        discardAudio();
        job.voice = fallbackVoice;
        job.voiceName = toVoiceName(fallbackVoice);
        job.voiceSource = "fallback";
        job.noAudioRetried = false;
        job.retries += 1;
        flushed = 0;
        started = 0;
        gateOpen = false;
        logInfo("第 " + (index + 1) + "/" + segments.length + " 段 音色 " + previousVoice +
            " 读 " + (job.lang || "这种语言") + " 未返回音频，改用默认音色 " + fallbackVoice +
            "，重新合成全部段，第 " + job.retries + " 次重试");
        launch();
    };

    job.expired = function (index) {
        if (nowMs() < job.deadline) { return false; }
        fail(makeError("network",
            "文本较长，" + Math.round(job.budgetMs / 1000) + " 秒内没有合成完，请分几次朗读",
            { kind: "budget", voice: job.voice, segment: index + 1, segments: segments.length,
                retries: job.retries }));
        return true;
    };

    function armBudgetTimer() {
        if (typeof $timer === "undefined" || !$timer || typeof $timer.schedule !== "function") { return; }
        budgetTimerId = $timer.schedule({
            interval: Math.max(0.001, (job.deadline - nowMs()) / 1000),
            repeats: false,
            handler: function () {
                budgetTimerId = null;
                if (!job.stopped && !job.expired(flushed)) { armBudgetTimer(); }
            }
        });
    }

    function fail(error) {
        if (job.stopped) {
            return;
        }
        job.stopped = true;
        clearBudgetTimer();
        cancelProbes();
        cancelConnections();
        discardAudio();
        var detail = error.addtion || {};
        logError("failed type=" + error.type +
            " kind=" + (detail.kind || "-") +
            " voice=" + job.voice + "(" + job.voiceSource + ")" +
            " segment=" + (detail.segment || "-") + "/" + segments.length +
            " retries=" + job.retries +
            " ms=" + (nowMs() - startedAt) +
            " detail=" + oneLine(JSON.stringify(detail), 500));
        callback(error, null);
    }

    function finishAll() {
        if (job.expired(flushed - 1)) { return; }
        var format = sniffAudio(sink.head);
        var base64 = sink.finish();
        if (job.expired(flushed - 1)) { return; }
        var ms = nowMs() - startedAt;
        job.stopped = true;
        clearBudgetTimer();
        cancelProbes();
        cancelConnections();
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
    }

    // 段可能乱序完成，按段序拼接；拼完就丢掉这段的帧
    function onSegmentDone(index, audio) {
        gateOpen = true;
        pending[index] = audio;
        while (flushed < segments.length && pending[flushed]) {
            var frames = pending[flushed].frames;
            pending[flushed] = null;
            for (var i = 0; i < frames.length; i++) {
                sink.append(frames[i].bytes, frames[i].start, frames[i].bytes.length);
            }
            frames.length = 0;
            flushed += 1;
        }
        if (flushed === segments.length) {
            finishAll();
            return;
        }
        launch();
    }

    function onFirstAudio() {
        if (!gateOpen) {
            gateOpen = true;
            launch();
        }
    }

    // 已启动但还没拼进 sink 的段不超过 parallel 段：同时在途的连接和压在内存里的音频都有上限
    function launch() {
        while (!job.stopped && started < segments.length && started < flushed + parallel &&
            (started === 0 || gateOpen)) {
            // 先占号再启动：桩或 Bob 可能同步回调并重入 launch
            var index = started;
            started += 1;
            startSegment(index);
        }
    }

    function startSegment(index) {
        synthesizeSegment(job, index, function (error, audio) {
            if (job.stopped) {
                return;
            }
            if (error) {
                fail(error);
                return;
            }
            onSegmentDone(index, audio);
        }, onFirstAudio);
    }

    armBudgetTimer();
    launch();
}

exports.synthesize = synthesize;
