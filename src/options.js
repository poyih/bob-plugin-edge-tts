// 从 Bob 设置解析音色和韵律，保留菜单与语言表的优先级。
var config = require("./config.js");
var utils = require("./utils.js");
var trimmed = utils.trimmed;
var oneLine = utils.oneLine;
var logInfo = utils.logInfo;

function readOption(name) {
    return trimmed(typeof $option !== "undefined" && $option ? $option[name] : "");
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

// 「按语言指定音色」文本框：fr=fr-FR-HenriNeural; de=de-DE-ConradNeural。分号、逗号或换行分隔，
// 全角标点也认；语言码不区分大小写，同一语言写了多次以最后一项为准；格式不对的项记日志后忽略。
function parseVoiceMap(text) {
    var map = {};
    var entries = String(text || "").replace(/；/g, ";").replace(/，/g, ",").replace(/＝/g, "=").split(/[;,\n]/);
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i].trim();
        if (!entry) {
            continue;
        }
        var separator = entry.indexOf("=");
        var lang = separator > 0 ? entry.slice(0, separator).trim() : "";
        var voice = separator > 0 ? entry.slice(separator + 1).trim() : "";
        if (!lang || !voice) {
            logInfo("按语言指定音色里有一项格式不对，已忽略：" + oneLine(entry, 80));
            continue;
        }
        map[lang.toLowerCase()] = voice;
    }
    return map;
}

function mappedVoiceFor(lang) {
    var text = readOption("voiceMap");
    if (!text) {
        return "";
    }
    return parseVoiceMap(text)[String(lang || "").toLowerCase()] || "";
}

// 优先级：自定义音色 > 当前语言的覆盖菜单 > 按语言指定 > 全局固定音色 > 内置语言表
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
    var mapped = mappedVoiceFor(lang);
    if (mapped) {
        return { voice: mapped, source: "map" };
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

exports.isValidVoice = isValidVoice;
exports.toVoiceName = toVoiceName;
exports.parseVoiceMap = parseVoiceMap;
exports.resolveVoice = resolveVoice;
exports.resolveProsody = resolveProsody;
