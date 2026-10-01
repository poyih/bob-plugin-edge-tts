// 日志、一次性回调与 Bob 错误对象等公共工具。
var LOG_TAG = "[edge-tts]";

function trimmed(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
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

// 兼容 Bob 文档中 addtion / addition 的两种拼写。
function makeError(type, message, detail) {
    return { type: type, message: message, addtion: detail, addition: detail };
}

exports.trimmed = trimmed;
exports.oneLine = oneLine;
exports.logInfo = logInfo;
exports.logError = logError;
exports.once = once;
exports.nowMs = nowMs;
exports.describeError = describeError;
exports.makeError = makeError;
