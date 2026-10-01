// 微软 Edge「大声朗读」接口的协议常量与音色表。
//
// 这是 Edge 浏览器的内部接口，不是公开 API，微软每隔几个月就会收紧一次校验。
// 协议常量取自 rany2/edge-tts 7.2.8（master 4bdb8e4，2026-03-22）的
// src/edge_tts/constants.py，只参考协议事实。接口失效时运行 make upstream 逐项对照
// 上游的最新值，跟着改这一个文件即可。

var TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
var CHROMIUM_FULL_VERSION = "143.0.3650.75";
var CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
var SEC_MS_GEC_VERSION = "1-" + CHROMIUM_FULL_VERSION;

var BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
var WSS_URL = "wss://" + BASE_URL + "/edge/v1";
var VOICE_LIST_URL = "https://" + BASE_URL + "/voices/list?trustedclienttoken=" + TRUSTED_CLIENT_TOKEN;

// 2025-12 起微软校验 UA：不像 Edge 的 UA 握手直接 403
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
    " (KHTML, like Gecko) Chrome/" + CHROMIUM_MAJOR_VERSION + ".0.0.0 Safari/537.36" +
    " Edg/" + CHROMIUM_MAJOR_VERSION + ".0.0.0";
var ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
var ACCEPT_LANGUAGE = "en-US,en;q=0.9";

// 48 kbps CBR mp3：各段的帧可以直接首尾拼接
var OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

// 单条 ssml 消息里文本（转义后）的 UTF-8 字节上限。上游用 4096，这里留出余量。
var MAX_SEGMENT_BYTES = 3000;

// 长文本分段合成的并发数。第 1 段收到第一帧音频（签名和音色都没问题）之后，后面的段最多这么多段
// 同时在途，按段序拼接；1 就是逐段串行。配合下面的首段切短，2026-09-28 在 Bob 里实测，约 1000 字
// 以上的文本比逐段串行省一半左右时间，84 次合成没有触发限流，见 docs/poc-findings.md 第 11 节。
var PARALLEL_SEGMENTS = 2;

// Bob 1.21.0 里，从插件入口（tts、pluginValidate、定时器与 $http 回调）建立的连接收音频只有约
// 240 KB/s，在 WebSocket 回调里建立的连接约 1 MB/s，与文本内容无关，原因在 Bob 一侧（见
// docs/poc-findings.md 11.4）。每次朗读的第一条连接必然建在入口里。文本转义后超过
// FIRST_SEGMENT_TRIGGER_BYTES 字节时，第 1 段只切 FIRST_SEGMENT_BYTES 字节以内的一两句：它很快返回首帧、
// 放闸，大块内容交给后面走得快的连接。约 2900 字节的文本因此从 6.2 秒降到 3.2 秒。
var FIRST_SEGMENT_BYTES = 300;
var FIRST_SEGMENT_TRIGGER_BYTES = 900;

// Windows FILETIME 纪元（1601-01-01）与 Unix 纪元相差的秒数
var WIN_EPOCH_SECONDS = 11644473600;
// Sec-MS-GEC 按 5 分钟取整；实测服务端接受相邻的一个窗口，偏差 10 分钟即 403
var GEC_WINDOW_SECONDS = 300;

var DEFAULT_RATE = "+0%";
var DEFAULT_PITCH = "+0Hz";
var DEFAULT_VOLUME = "+0%";

var VOICE_MODE_AUTO = "auto";
var VOICE_MODE_GLOBAL = "global";
// 语言覆盖菜单里代表「不覆盖」的哨兵值
var FOLLOW_MODE = "auto";
// Multilingual 系列实测能读中 / 英 / 日 / 韩 / 法 / 德 / 西 / 俄 / 阿 / 印地 / 泰 / 越，
// 适合做全局固定音色；普通音色只能读本语言（中日韩音色还能读英文）
var DEFAULT_GLOBAL_VOICE = "en-US-EmmaMultilingualNeural";

// Bob 语言代码 -> 默认音色 ShortName。supportLanguages() 由这张表推导。
// 语言代码以 Bob 会传给插件的为准：2026-09-28 与社区插件 openai-translator 的 lang.ts 核对过，
// Bob 用 no / tl / jw / pt / sr-Cyrl / sr-Latn，没有 nb / fil / jv / pt-pt / pt-br。
// 音色 2026-09-27 对照 voices/list（322 个音色）逐个核对过，全部存在；之后可以用 make voices 联网复核。
var DEFAULT_VOICES = [
    ["zh-Hans", "zh-CN-XiaoxiaoNeural"],
    ["zh-Hant", "zh-TW-HsiaoChenNeural"],
    ["yue", "zh-HK-HiuMaanNeural"],
    // 文言文按普通话读
    ["wyw", "zh-CN-XiaoxiaoNeural"],
    ["en", "en-US-AriaNeural"],
    ["ja", "ja-JP-NanamiNeural"],
    ["ko", "ko-KR-SunHiNeural"],
    ["fr", "fr-FR-DeniseNeural"],
    ["de", "de-DE-KatjaNeural"],
    ["es", "es-ES-ElviraNeural"],
    ["it", "it-IT-ElsaNeural"],
    ["ru", "ru-RU-SvetlanaNeural"],
    ["pt", "pt-BR-FranciscaNeural"],
    ["nl", "nl-NL-ColetteNeural"],
    ["pl", "pl-PL-ZofiaNeural"],
    ["ar", "ar-SA-ZariyahNeural"],
    ["hi", "hi-IN-SwaraNeural"],
    ["tr", "tr-TR-EmelNeural"],
    ["vi", "vi-VN-HoaiMyNeural"],
    ["th", "th-TH-PremwadeeNeural"],
    ["id", "id-ID-GadisNeural"],
    ["ms", "ms-MY-YasminNeural"],
    ["uk", "uk-UA-PolinaNeural"],
    ["cs", "cs-CZ-VlastaNeural"],
    ["da", "da-DK-ChristelNeural"],
    ["fi", "fi-FI-NooraNeural"],
    ["el", "el-GR-AthinaNeural"],
    ["he", "he-IL-HilaNeural"],
    ["hu", "hu-HU-NoemiNeural"],
    ["no", "nb-NO-PernilleNeural"],
    ["ro", "ro-RO-AlinaNeural"],
    ["sk", "sk-SK-ViktoriaNeural"],
    ["sv", "sv-SE-SofieNeural"],
    ["af", "af-ZA-AdriNeural"],
    ["am", "am-ET-MekdesNeural"],
    ["az", "az-AZ-BanuNeural"],
    ["bg", "bg-BG-KalinaNeural"],
    ["bn", "bn-BD-NabanitaNeural"],
    ["bs", "bs-BA-VesnaNeural"],
    ["ca", "ca-ES-JoanaNeural"],
    ["cy", "cy-GB-NiaNeural"],
    ["et", "et-EE-AnuNeural"],
    ["fa", "fa-IR-DilaraNeural"],
    ["tl", "fil-PH-BlessicaNeural"],
    ["ga", "ga-IE-OrlaNeural"],
    ["gl", "gl-ES-SabelaNeural"],
    ["gu", "gu-IN-DhwaniNeural"],
    ["hr", "hr-HR-GabrijelaNeural"],
    ["is", "is-IS-GudrunNeural"],
    ["jw", "jv-ID-SitiNeural"],
    ["ka", "ka-GE-EkaNeural"],
    ["kk", "kk-KZ-AigulNeural"],
    ["km", "km-KH-SreymomNeural"],
    ["kn", "kn-IN-SapnaNeural"],
    ["lo", "lo-LA-KeomanyNeural"],
    ["lt", "lt-LT-OnaNeural"],
    ["lv", "lv-LV-EveritaNeural"],
    ["mk", "mk-MK-MarijaNeural"],
    ["ml", "ml-IN-SobhanaNeural"],
    ["mn", "mn-MN-YesuiNeural"],
    ["mr", "mr-IN-AarohiNeural"],
    ["mt", "mt-MT-GraceNeural"],
    ["my", "my-MM-NilarNeural"],
    ["ne", "ne-NP-HemkalaNeural"],
    ["ps", "ps-AF-LatifaNeural"],
    ["si", "si-LK-ThiliniNeural"],
    ["sl", "sl-SI-PetraNeural"],
    ["so", "so-SO-UbaxNeural"],
    ["sq", "sq-AL-AnilaNeural"],
    ["sr", "sr-RS-SophieNeural"],
    ["sr-Cyrl", "sr-RS-SophieNeural"],
    // Edge 只有西里尔字母的塞尔维亚语音色，拉丁字母的文本也交给它试
    ["sr-Latn", "sr-RS-SophieNeural"],
    ["su", "su-ID-TutiNeural"],
    ["sw", "sw-KE-ZuriNeural"],
    ["ta", "ta-IN-PallaviNeural"],
    ["te", "te-IN-ShrutiNeural"],
    ["ur", "ur-PK-UzmaNeural"],
    ["uz", "uz-UZ-MadinaNeural"],
    ["zu", "zu-ZA-ThandoNeural"]
];

// 有独立覆盖菜单的六种语言。Bob 的设置项是静态的，六个菜单会同时显示，
// 插件只读当前朗读语言对应的那一个。
var LANGUAGE_OVERRIDES = [
    { lang: "zh-Hans", option: "voiceZhHans" },
    { lang: "zh-Hant", option: "voiceZhHant" },
    { lang: "yue", option: "voiceYue" },
    { lang: "en", option: "voiceEn" },
    { lang: "ja", option: "voiceJa" },
    { lang: "ko", option: "voiceKo" }
];

function lookup(pairs, key) {
    for (var i = 0; i < pairs.length; i++) {
        if (pairs[i][0] === key) {
            return pairs[i][1];
        }
    }
    return "";
}

function defaultVoiceFor(lang) {
    return lookup(DEFAULT_VOICES, String(lang || ""));
}

function overrideOptionFor(lang) {
    for (var i = 0; i < LANGUAGE_OVERRIDES.length; i++) {
        if (LANGUAGE_OVERRIDES[i].lang === lang) {
            return LANGUAGE_OVERRIDES[i].option;
        }
    }
    return "";
}

function supportedLanguages() {
    var out = [];
    for (var i = 0; i < DEFAULT_VOICES.length; i++) {
        out.push(DEFAULT_VOICES[i][0]);
    }
    return out;
}

exports.TRUSTED_CLIENT_TOKEN = TRUSTED_CLIENT_TOKEN;
exports.CHROMIUM_FULL_VERSION = CHROMIUM_FULL_VERSION;
exports.SEC_MS_GEC_VERSION = SEC_MS_GEC_VERSION;
exports.WSS_URL = WSS_URL;
exports.VOICE_LIST_URL = VOICE_LIST_URL;
exports.USER_AGENT = USER_AGENT;
exports.ORIGIN = ORIGIN;
exports.ACCEPT_LANGUAGE = ACCEPT_LANGUAGE;
exports.OUTPUT_FORMAT = OUTPUT_FORMAT;
exports.MAX_SEGMENT_BYTES = MAX_SEGMENT_BYTES;
exports.PARALLEL_SEGMENTS = PARALLEL_SEGMENTS;
exports.FIRST_SEGMENT_BYTES = FIRST_SEGMENT_BYTES;
exports.FIRST_SEGMENT_TRIGGER_BYTES = FIRST_SEGMENT_TRIGGER_BYTES;
exports.WIN_EPOCH_SECONDS = WIN_EPOCH_SECONDS;
exports.GEC_WINDOW_SECONDS = GEC_WINDOW_SECONDS;
exports.DEFAULT_RATE = DEFAULT_RATE;
exports.DEFAULT_PITCH = DEFAULT_PITCH;
exports.DEFAULT_VOLUME = DEFAULT_VOLUME;
exports.VOICE_MODE_AUTO = VOICE_MODE_AUTO;
exports.VOICE_MODE_GLOBAL = VOICE_MODE_GLOBAL;
exports.FOLLOW_MODE = FOLLOW_MODE;
exports.DEFAULT_GLOBAL_VOICE = DEFAULT_GLOBAL_VOICE;
exports.DEFAULT_VOICES = DEFAULT_VOICES;
exports.LANGUAGE_OVERRIDES = LANGUAGE_OVERRIDES;
exports.defaultVoiceFor = defaultVoiceFor;
exports.overrideOptionFor = overrideOptionFor;
exports.supportedLanguages = supportedLanguages;
