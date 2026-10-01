// Bob 插件入口：校验输入，解析设置，把完整音频交回宿主。
var config = require("./config.js");
var textUtil = require("./text.js");
var protocol = require("./protocol.js");
var transport = require("./connection.js");
var voiceOptions = require("./options.js");
var utils = require("./utils.js");
var synthesize = require("./synthesis.js").synthesize;
var once = utils.once;
var logError = utils.logError;
var oneLine = utils.oneLine;
var describeError = utils.describeError;
var makeError = utils.makeError;
var resolveVoice = voiceOptions.resolveVoice;

// Bob 宿主超时。插件自己的总预算必须更短，才有机会把明确的错误交回 Bob。
var PLUGIN_TIMEOUT_INTERVAL = 60;
var TOTAL_BUDGET_MS = 55000;
var VALIDATE_BUDGET_MS = 25000;

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

// 仅供离线回归测试，Bob 不会调用。
exports.__test = {
    sha256Hex: protocol.sha256Hex,
    gecPayload: protocol.gecPayload,
    secMsGec: protocol.secMsGec,
    randomHex: protocol.randomHex,
    connectionId: protocol.connectionId,
    buildUrl: protocol.buildUrl,
    buildHeaders: protocol.buildHeaders,
    timestampString: protocol.timestampString,
    buildConfigMessage: protocol.buildConfigMessage,
    buildSsml: protocol.buildSsml,
    buildSsmlMessage: protocol.buildSsmlMessage,
    dataToBytes: protocol.dataToBytes,
    parseBinaryFrame: protocol.parseBinaryFrame,
    parseTextFrame: protocol.parseTextFrame,
    parseHttpDate: protocol.parseHttpDate,
    Base64Sink: protocol.Base64Sink,
    isValidVoice: voiceOptions.isValidVoice,
    toVoiceName: voiceOptions.toVoiceName,
    parseVoiceMap: voiceOptions.parseVoiceMap,
    resolveVoice: voiceOptions.resolveVoice,
    resolveProsody: voiceOptions.resolveProsody,
    cleanText: textUtil.cleanText,
    escapeXml: textUtil.escapeXml,
    splitText: textUtil.splitText,
    prepareSegments: textUtil.prepareSegments,
    validationSample: validationSample,
    getClockSkewMs: transport.getClockSkewMs,
    setClockSkewMs: transport.setClockSkewMs,
    activeSocketCount: transport.activeSocketCount
};
