// 本地测试：用 macOS 自带的 jsc（Bob 插件运行时用的同一个 JavaScriptCore）跑 src/main.js，
// $websocket / $data / $option / $log / $http / $timer 全部用桩替换，不联网，不会真的连微软的接口。
//
// 用法：make test
//
// jsc 路径：/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

var failures = [];
var checks = 0;

function ok(condition, label) {
    checks += 1;
    if (!condition) {
        failures.push(label);
        print("FAIL  " + label);
    } else {
        print("ok    " + label);
    }
}

function brief(value) {
    var text = JSON.stringify(value);
    if (text === undefined) {
        text = String(value);
    }
    return text.length > 160 ? text.slice(0, 157) + "...（共 " + text.length + " 字符）" : text;
}

function eq(actual, expected, label) {
    var same = actual === expected;
    ok(same, same ? label : label + "（期望 " + brief(expected) + "，实际 " + brief(actual) + "）");
}

// ------------------------------------------------------------ 与插件无关的参考实现

function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
            var d = str.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                i += 1;
            }
        }
        if (c < 0x80) {
            bytes.push(c);
        } else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0x10000) {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
            bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return bytes;
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
        var b0 = bytes[i];
        var b1 = bytes[i + 1];
        var b2 = bytes[i + 2];
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
        out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
        out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
}

function hex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
        out += ("0" + bytes[i].toString(16)).slice(-2);
    }
    return out;
}

function repeat(str, times) {
    return new Array(times + 1).join(str);
}

// 固定种子的伪随机数，保证每次跑的用例相同
var seed = 20260927;

function random(limit) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
}

// ------------------------------------------------------------ 运行时桩

// 刻意不暴露 length：Bob 实际运行时 $data 就没有这个属性。
// shape 决定暴露哪些取字节的方法，用来覆盖 toByteArray / toHex / toBase64 三条路径。
function makeData(bytes, shape) {
    var data = { __data: true };
    if (!shape || shape === "byteArray") {
        data.toByteArray = function () {
            return bytes.slice();
        };
    }
    if (!shape || shape === "byteArray" || shape === "hex") {
        data.toHex = function () {
            return hex(bytes);
        };
    }
    data.toBase64 = function () {
        return base64(bytes);
    };
    return data;
}

globalThis.$data = {
    isData: function (v) {
        return !!(v && v.__data);
    },
    fromByteArray: function (bytes) {
        return makeData(bytes);
    },
    fromUTF8: function (s) {
        return makeData(utf8Bytes(s));
    }
};

var logs = [];

globalThis.$log = {
    info: function (m) {
        logs.push(String(m));
    },
    error: function (m) {
        logs.push(String(m));
    }
};

function loggedLine(needle) {
    return logs.some(function (line) {
        return line.indexOf(needle) >= 0;
    });
}

globalThis.$option = {};

// 可以拨动的时钟：Date.now() = 真实时间 + clockOffset
var realNow = Date.now;
var clockOffset = 0;

Date.now = function () {
    return realNow.call(Date) + clockOffset;
};

function serverNow() {
    return realNow.call(Date);
}

// 定时器不会自己触发，由用例手动触发
var timers = [];

globalThis.$timer = {
    schedule: function (options) {
        var timer = {
            id: timers.length + 1,
            interval: options.interval,
            repeats: options.repeats,
            handler: options.handler,
            active: true
        };
        timers.push(timer);
        return timer.id;
    },
    invalidate: function (id) {
        if (timers[id - 1]) {
            timers[id - 1].active = false;
        }
    }
};

function fireTimer(timer) {
    if (!timer.active) {
        return false;
    }
    if (!timer.repeats) {
        timer.active = false;
    }
    timer.handler();
    return true;
}

function activeTimers() {
    return timers.filter(function (t) {
        return t.active;
    }).length;
}

// 插件的看门狗一次只挂一个定时器，到点没事就重新挂一个；用例只关心当前还活着的那个
function fireActiveTimer() {
    for (var i = timers.length - 1; i >= 0; i--) {
        if (timers[i].active) {
            return fireTimer(timers[i]);
        }
    }
    return false;
}

// 每新建一条连接取走一个脚本，open() 时执行；没有脚本的连接 open 之后什么都不发生。
var sockets = [];
var socketScripts = [];
// Bob 在插件调用 close() 之后可能再回调一次 listenClose，这里同步地模拟出来
var echoCloseEvent = true;

globalThis.$websocket = {
    new: function (params) {
        var socket = {
            params: params,
            handlers: {},
            sent: [],
            openCalls: 0,
            closeCalls: 0,
            closeArgTypes: [],
            readyState: 0,
            listenOpen: function (fn) {
                this.handlers.open = fn;
            },
            listenClose: function (fn) {
                this.handlers.close = fn;
            },
            listenError: function (fn) {
                this.handlers.error = fn;
            },
            listenReceiveString: function (fn) {
                this.handlers.text = fn;
            },
            listenReceiveData: function (fn) {
                this.handlers.data = fn;
            },
            sendString: function (text) {
                this.sent.push(text);
            },
            open: function () {
                this.openCalls += 1;
                if (this.script) {
                    this.script(this);
                }
            },
            close: function (options) {
                this.closeArgTypes.push(arguments.length === 0 ? "none" : typeof options);
                this.closeCalls += 1;
                this.readyState = 3;
                if (echoCloseEvent) {
                    this.handlers.close(this, 1000, "");
                }
            },
            fireOpen: function () {
                this.readyState = 1;
                this.handlers.open(this);
            },
            fireText: function (text) {
                this.handlers.text(this, text);
            },
            fireData: function (data) {
                this.handlers.data(this, data);
            },
            fireError: function (error) {
                this.handlers.error(this, error);
            },
            fireClose: function (code, reason) {
                this.handlers.close(this, code, reason);
            }
        };
        socket.script = socketScripts.shift();
        sockets.push(socket);
        return socket;
    }
};

var httpRequests = [];
var httpResponder = null;

globalThis.$http = {
    request: function (req) {
        httpRequests.push(req);
        var resp = httpResponder ? httpResponder(req) : { error: { message: "offline" }, response: null };
        req.handler(resp);
    }
};

// ------------------------------------------------------------ 加载插件

// 与 Bob 一样：每个文件各自的 exports，require("./x.js") 拿到已加载模块的 exports
var modules = {};

globalThis.require = function (path) {
    var name = String(path).replace(/^\.\//, "");
    if (!modules[name]) {
        throw new Error("未知模块: " + path);
    }
    return modules[name];
};

function loadModule(name) {
    globalThis.exports = {};
    load("src/" + name);
    modules[name] = globalThis.exports;
    return modules[name];
}

var config = loadModule("config.js");
loadModule("sha256.js");
loadModule("text.js");
var plugin = loadModule("main.js");
var T = plugin.__test;

// ------------------------------------------------------------ 协议桩：帧与服务端行为

var AUDIO_HEADER = "X-RequestId:0123456789abcdef0123456789abcdef\r\nContent-Type:audio/mpeg\r\n" +
    "X-StreamId:1E708CCA91694AA5B8939B0B6CED7DCE\r\nPath:audio\r\n";
var END_HEADER = "X-RequestId:0123456789abcdef0123456789abcdef\r\n" +
    "X-StreamId:1E708CCA91694AA5B8939B0B6CED7DCE\r\nPath:audio\r\n";

function binaryFrame(header, audio) {
    var bytes = [header.length >> 8, header.length & 0xff];
    for (var i = 0; i < header.length; i++) {
        bytes.push(header.charCodeAt(i));
    }
    return bytes.concat(audio || []);
}

function textFrame(path, body) {
    return "X-RequestId:0123456789abcdef0123456789abcdef\r\n" +
        "Content-Type:application/json; charset=utf-8\r\nPath:" + path + "\r\n\r\n" + (body || "{}");
}

// 一段假的 mp3：以帧同步字 ff f3 开头，后面是伪随机字节
function fakeAudio(length) {
    var bytes = [0xff, 0xf3, 0x64, 0xc4];
    while (bytes.length < length) {
        bytes.push(random(256));
    }
    return bytes.slice(0, length);
}

// 正常的一轮：turn.start / response / 若干音频帧穿插 metadata / 空的结束帧 / turn.end，
// 然后服务端关闭连接
function successScript(audio, frameSize, shape) {
    return function (socket) {
        socket.fireOpen();
        socket.fireText(textFrame("turn.start", "{\"context\":{\"serviceTag\":\"x\"}}"));
        socket.fireText(textFrame("response", "{\"audio\":{\"type\":\"inline\"}}"));
        for (var i = 0; i < audio.length; i += frameSize) {
            socket.fireData(makeData(binaryFrame(AUDIO_HEADER, audio.slice(i, i + frameSize)), shape));
            socket.fireText(textFrame("audio.metadata", "{\"Metadata\":[]}"));
        }
        socket.fireData(makeData(binaryFrame(END_HEADER, []), shape));
        socket.fireText(textFrame("turn.end"));
        socket.fireClose(1000, "");
    };
}

function noAudioScript(socket) {
    socket.fireOpen();
    socket.fireText(textFrame("turn.start"));
    socket.fireText(textFrame("response"));
    socket.fireData(makeData(binaryFrame(END_HEADER, [])));
    socket.fireText(textFrame("turn.end"));
}

// Starscream 对非 101 响应报 upgrade error；随后可能还会来一个 close
function rejectScript(socket) {
    socket.fireError({ code: 403, message: "Invalid HTTP upgrade", type: "upgradeError" });
    socket.fireClose(1006, "");
}

function openOnlyScript(socket) {
    socket.fireOpen();
}

function closeScript(code, reason) {
    return function (socket) {
        socket.fireOpen();
        socket.fireText(textFrame("turn.start"));
        socket.fireClose(code, reason);
    };
}

// 按微软的规则校验签名：与服务器时间所在的 5 分钟窗口或相邻窗口一致才放行
function serverAccepts(url) {
    var match = /Sec-MS-GEC=([0-9A-F]{64})(&|$)/.exec(url);
    if (!match) {
        return false;
    }
    for (var k = -1; k <= 1; k++) {
        if (match[1] === T.secMsGec(serverNow() / 1000 + k * 300)) {
            return true;
        }
    }
    return false;
}

function edgeServerScript(audio) {
    return function (socket) {
        if (!serverAccepts(socket.params.url)) {
            rejectScript(socket);
            return;
        }
        successScript(audio, 720)(socket);
    };
}

function httpDateResponder(headerName) {
    return function () {
        var headers = { "Content-Type": "application/json; charset=utf-8" };
        headers[headerName] = new Date(serverNow()).toUTCString();
        return { response: { statusCode: 200, headers: headers }, data: [] };
    };
}

// ------------------------------------------------------------ 用例工具

var BASE_OPTIONS = {
    voiceMode: "auto",
    globalVoice: "en-US-EmmaMultilingualNeural",
    voiceZhHans: "auto",
    voiceZhHant: "auto",
    voiceYue: "auto",
    voiceEn: "auto",
    voiceJa: "auto",
    voiceKo: "auto",
    customVoice: "",
    rate: "+0%",
    pitch: "+0Hz",
    volume: "+0%"
};

function reset(overrides) {
    var opts = {};
    Object.keys(BASE_OPTIONS).forEach(function (k) {
        opts[k] = BASE_OPTIONS[k];
    });
    Object.keys(overrides || {}).forEach(function (k) {
        opts[k] = overrides[k];
    });
    globalThis.$option = opts;
    logs = [];
    timers = [];
    sockets = [];
    socketScripts = [];
    httpRequests = [];
    httpResponder = null;
    clockOffset = 0;
    echoCloseEvent = true;
    T.setClockSkewMs(0);
}

// 桩都是同步的，tts 返回时 completion 要么已经被调用，要么在等定时器
function speak(query) {
    var calls = [];
    plugin.tts(query, function (value) {
        calls.push(value);
    });
    return calls;
}

function validate() {
    var calls = [];
    plugin.pluginValidate(function (value) {
        calls.push(value);
    });
    return calls;
}

function ssmlOf(socket) {
    return socket.sent[1] || "";
}

function hasLoneSurrogate(str) {
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            var d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
            if (d < 0xdc00 || d > 0xdfff) {
                return true;
            }
            i += 1;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function hasBrokenEntity(str) {
    return /&(?!(?:amp|lt|gt);)/.test(str);
}

function stripSpace(str) {
    return str.replace(/\s+/g, "");
}

// 分段结果必须满足的不变量
function checkSegments(text, limit, label) {
    var segments = T.splitText(text, limit);
    var withinLimit = segments.every(function (s) {
        return utf8Bytes(s).length <= limit;
    });
    var intactUtf8 = !segments.some(hasLoneSurrogate);
    var intactEntities = !segments.some(hasBrokenEntity);
    var nonEmpty = segments.every(function (s) {
        return s.length > 0 && s === s.trim();
    });
    var preserved = stripSpace(segments.join("")) === stripSpace(text);
    ok(withinLimit && intactUtf8 && intactEntities && nonEmpty && preserved,
        label + "：每段不超过 " + limit + " 字节、不切开字符与实体、内容不丢（" + segments.length + " 段）");
    return segments;
}

var ZH = { text: "你好，世界", lang: "zh-Hans" };
var XIAOXIAO_FULL = "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)";

// ------------------------------------------------------------ 用例

(function () {
    var r;
    var s;
    var i;

    // 1. 基本接口
    reset();
    var langs = plugin.supportLanguages();
    ok(Array.isArray(langs) && langs.length >= 60, "supportLanguages 返回语言数组（" + langs.length + " 种）");
    ok(["zh-Hans", "zh-Hant", "yue", "en", "ja", "ko", "fr", "de", "es", "it", "ru", "pt", "nl", "pl", "ar", "hi",
        "tr", "vi", "th", "id", "ms", "uk", "cs", "da", "fi", "el", "he", "hu", "nb", "ro", "sk", "sv"]
        .every(function (l) { return langs.indexOf(l) >= 0; }), "语言列表覆盖任务卡要求的全部语言");
    ok(langs.indexOf("auto") < 0, "TTS 语言列表不含 auto");
    eq(langs.length, config.DEFAULT_VOICES.length, "supportLanguages 由内置音色表推导");
    eq(plugin.pluginTimeoutInterval(), 60, "pluginTimeoutInterval 为 60 秒");
    eq(config.defaultVoiceFor("zh-Hans"), "zh-CN-XiaoxiaoNeural", "zh-Hans 默认晓晓");
    eq(config.defaultVoiceFor("zh-Hant"), "zh-TW-HsiaoChenNeural", "zh-Hant 默认曉臻");
    eq(config.defaultVoiceFor("yue"), "zh-HK-HiuMaanNeural", "yue 默认曉曼");
    eq(config.defaultVoiceFor("en"), "en-US-AriaNeural", "en 默认 Aria");
    eq(config.defaultVoiceFor("ja"), "ja-JP-NanamiNeural", "ja 默认七海");
    eq(config.defaultVoiceFor("ko"), "ko-KR-SunHiNeural", "ko 默认 SunHi");
    eq(config.defaultVoiceFor("tlh"), "", "表外语言没有默认音色");
    eq(config.MAX_SEGMENT_BYTES, 3000, "分段上限 3000 字节");

    // 2. SHA-256 已知答案
    eq(T.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256(abc)");
    eq(T.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA256(空串)");
    eq(T.sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", "SHA256(448 位两块消息)");
    eq(T.sha256Hex(repeat("a", 55)), "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
        "SHA256(55 字节，填充后正好一块)");
    eq(T.sha256Hex(repeat("a", 56)), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
        "SHA256(56 字节，填充溢出到第二块)");
    eq(T.sha256Hex(repeat("a", 64)), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
        "SHA256(64 字节)");
    eq(T.sha256Hex(repeat("a", 1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
        "SHA256(1000 字节)");
    eq(T.sha256Hex("你好，世界 😀"), "5b2150ba07ef1483047aab372a4be844764b062cb1d2acc1c4e90be0a2b5ceb0",
        "SHA256 按 UTF-8 处理中文与 emoji");

    // 3. Sec-MS-GEC
    eq(T.gecPayload(1700000000), "1334447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4", "Unix 1700000000 的待哈希字串");
    eq(T.secMsGec(1700000000), "42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF",
        "Unix 1700000000 的 Sec-MS-GEC");
    eq(T.gecPayload(1760000000.789), "1340447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4",
        "Unix 1760000000.789 的待哈希字串（小数被舍去）");
    eq(T.secMsGec(1760000000.789), "70AED27457006C255086B4F079B9FE44A4D10827C4AFDFC3C45583B6F40D7DDF",
        "Unix 1760000000.789 的 Sec-MS-GEC");
    eq(T.secMsGec(1790478614), "E4C4F86613D52B4AD21C1129AB2E52A658B8B0ADF200580B838CD1AE4ADF0ECD",
        "2026-09-27 的 Sec-MS-GEC");
    eq(T.secMsGec(1790478899.999), T.secMsGec(1790478614), "同一个 5 分钟窗口内签名相同");
    eq(T.secMsGec(1790478900), "20DFD04D973BFEDEF7D3B7C62CD47D2B4B90C258D35064D24F7ACF444665532B",
        "跨过 5 分钟边界签名改变");
    eq(T.gecPayload(0), "1164447360000000006A5AA1D4EAFF4E9FB37E23D68491D6F4", "Unix 0 的待哈希字串");
    ok([0, 1700000000, 1760000000.789, 1790478614, 4102444800, 32503680000].every(function (t) {
        return /^\d{18,19}6A5AA1D4EAFF4E9FB37E23D68491D6F4$/.test(T.gecPayload(t));
    }), "ticks 字串是纯十进制数字，不出现科学计数法或小数点");
    eq(T.gecPayload(4102444800), "1574691840000000006A5AA1D4EAFF4E9FB37E23D68491D6F4", "2100 年的 ticks 仍然精确");
    ok(/^[0-9A-F]{64}$/.test(T.secMsGec(Date.now() / 1000)), "Sec-MS-GEC 是 64 位大写 hex");

    // 4. URL、握手头、随机数
    var url = T.buildUrl(1700000000);
    ok(url.indexOf("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?") === 0,
        "URL 指向 readaloud/edge/v1");
    ok(url.indexOf("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4") > 0, "URL 带 TrustedClientToken");
    ok(/&ConnectionId=[0-9a-f]{32}&/.test(url), "ConnectionId 是 32 位小写 hex");
    ok(url.indexOf("&Sec-MS-GEC=42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF") > 0,
        "URL 带 Sec-MS-GEC");
    ok(/&Sec-MS-GEC-Version=1-143\.0\.3650\.75$/.test(url), "URL 以 Sec-MS-GEC-Version=1-143.0.3650.75 结尾");
    ok(T.buildUrl(1700000000) !== url, "每条连接的 ConnectionId 不同");
    var id = T.connectionId();
    ok(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(id), "ConnectionId 形同 UUID v4");

    var headers = T.buildHeaders();
    eq(headers["User-Agent"], "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0", "User-Agent 是 Edge 143");
    eq(headers.Origin, "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold", "Origin 是朗读扩展");
    ok(/^muid=[0-9A-F]{32};$/.test(headers.Cookie), "Cookie 是 muid=32 位大写 hex;");
    ok(T.buildHeaders().Cookie !== headers.Cookie, "MUID 每次随机生成");
    ok(headers.Pragma === "no-cache" && headers["Cache-Control"] === "no-cache" &&
        headers["Accept-Language"] === "en-US,en;q=0.9", "带 Pragma / Cache-Control / Accept-Language");
    ok(Object.keys(headers).every(function (k) {
        return typeof headers[k] === "string" && !/^sec-websocket/i.test(k);
    }), "握手头的值都是字符串，且不手填 Sec-WebSocket-*");

    // 5. 时间戳与两条消息
    eq(T.timestampString(1790478614000), "Sun Sep 27 2026 03:10:14 GMT+0000 (Coordinated Universal Time)",
        "X-Timestamp 是 UTC 的 JS Date 字串");
    eq(T.timestampString(1767225600000), "Thu Jan 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
        "日期与时分秒补零");
    eq(T.buildConfigMessage(1790478614000),
        "X-Timestamp:Sun Sep 27 2026 03:10:14 GMT+0000 (Coordinated Universal Time)\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\"," +
        "\"wordBoundaryEnabled\":\"true\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n",
        "speech.config 消息逐字节符合协议");
    var prosody = { rate: "+0%", pitch: "+0Hz", volume: "+0%" };
    var ssmlMessage = T.buildSsmlMessage(1790478614000, "VOICE", prosody, "已转义文本");
    ok(/^X-RequestId:[0-9a-f]{32}\r\nContent-Type:application\/ssml\+xml\r\nX-Timestamp:Sun Sep 27 2026 03:10:14 GMT\+0000 \(Coordinated Universal Time\)Z\r\nPath:ssml\r\n\r\n/
        .test(ssmlMessage), "ssml 消息的头：X-RequestId、Content-Type、带 Z 的 X-Timestamp、Path");
    eq(ssmlMessage.split("\r\n\r\n")[1],
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='VOICE'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>已转义文本</prosody></voice></speak>",
        "SSML 正文逐字节符合协议");

    // 6. 控制字符清理与 XML 转义
    eq(T.cleanText("a\u0000b\u0008c\u000bd\u000ce\u000ef\u001fg"), "a b c d e f g", "控制字符 0–8、11、12、14–31 换成空格");
    eq(T.cleanText("a\tb\nc\rd"), "a\tb\nc\rd", "制表符、换行、回车保留");
    eq(T.cleanText("笑😀脸"), "笑😀脸", "成对的代理项（emoji）保留");
    eq(T.cleanText("a\ud83db\ude00c\ud83d"), "a b c ", "落单的代理项换成空格");
    eq(T.cleanText("a￾b￿c"), "a b c", "U+FFFE / U+FFFF 换成空格");
    eq(T.cleanText(null), "", "null 当作空串");
    eq(T.escapeXml("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d", "& < > 被转义");
    eq(T.escapeXml("&amp;"), "&amp;amp;", "已有的实体字面量会再转义一次，读出来仍是原文");
    eq(T.escapeXml("it's \"ok\""), "it's \"ok\"", "引号在元素内容里不需要转义");

    // 7. 分段
    eq(JSON.stringify(T.splitText("你好，世界", 3000)), JSON.stringify(["你好，世界"]), "短文本不分段");
    eq(T.splitText("   \n\t  ", 3000).length, 0, "只有空白的文本得到 0 段");
    eq(JSON.stringify(T.splitText("  hello  ", 3000)), JSON.stringify(["hello"]), "首尾空白被去掉");

    var sentence = "语音合成 (TTS) 把文字变成声音。Bob 可以用它朗读 selected text，非常方便！你觉得呢？" +
        "价格是 3.14 元，库存 1,000 件；A&B 公司 <内部> 资料。\n";
    var longMixed = repeat(sentence, 120);
    var escapedLong = T.escapeXml(longMixed);
    ok(utf8Bytes(escapedLong).length > 3000 * 5, "构造的中英混合长文本超过 15000 字节");
    s = checkSegments(escapedLong, 3000, "中英混合长文本");
    ok(s.length >= 6, "长文本被切成多段");
    ok(s.slice(0, -1).every(function (seg) {
        return /[。！？!?.；;]$/.test(seg) || /[。！？]["”）)]$/.test(seg);
    }), "除最后一段外每段都在句末标点处结束");
    ok(s.slice(0, -1).every(function (seg) {
        return utf8Bytes(seg).length > 1500;
    }), "切点落在窗口后半段，不会产生很短的段");
    ok(s.join("").indexOf("A&amp;B") > 0 && s.join("").indexOf("&lt;内部&gt;") > 0, "实体完整保留");

    eq(JSON.stringify(T.prepareSegments("a<b\u000bc")), JSON.stringify(["a&lt;b c"]), "prepareSegments 先清理再转义");
    s = T.prepareSegments(longMixed);
    ok(s.length >= 6 && s.every(function (seg) { return utf8Bytes(seg).length <= 3000; }),
        "prepareSegments 按转义后的字节数分段");

    // 没有任何标点和空白时只能硬切：不能切开多字节字符、代理对和实体
    var dense = "";
    for (i = 0; i < 400; i++) {
        dense += ["中", "é", "a", "😀", "&amp;", "&lt;", "&gt;", "文"][random(8)];
    }
    [16, 17, 18, 19, 20, 23, 31, 64, 100, 257].forEach(function (limit) {
        checkSegments(dense, limit, "无标点文本硬切 limit=" + limit);
    });
    checkSegments(repeat("😀", 50), 18, "连续 emoji（4 字节）");
    checkSegments(repeat("&amp;", 50), 16, "连续实体");

    // 随机混合文本 + 随机上限
    var pieces = ["你好", "世界", "hello", " ", "，", "。", "！", "\n", ". ", ", ", "&amp;", "&lt;", "3.14", "😀",
        "é", "こんにちは", "안녕", "；", "、", "”", "(", ")", "؟", "।"];
    var randomOk = true;
    for (var round = 0; round < 60; round++) {
        var text = "";
        var count = 50 + random(300);
        for (i = 0; i < count; i++) {
            text += pieces[random(pieces.length)];
        }
        var limit = 16 + random(200);
        var segs = T.splitText(text, limit);
        if (!segs.every(function (seg) { return utf8Bytes(seg).length <= limit && seg === seg.trim() && seg; }) ||
            segs.some(hasLoneSurrogate) || segs.some(hasBrokenEntity) ||
            stripSpace(segs.join("")) !== stripSpace(text)) {
            randomOk = false;
            print("      反例 limit=" + limit + " text=" + JSON.stringify(text));
            break;
        }
    }
    ok(randomOk, "60 组随机文本 × 随机上限都满足分段不变量");

    eq(JSON.stringify(T.splitText("第一句话。第二句话。第三句话。", 32)),
        JSON.stringify(["第一句话。第二句话。", "第三句话。"]), "优先在句号处切分");
    eq(JSON.stringify(T.splitText("他说：“你好。”然后就走了，头也不回。", 36)),
        JSON.stringify(["他说：“你好。”", "然后就走了，头也不回。"]), "句号后面的引号留在前一段");
    eq(JSON.stringify(T.splitText("pi is 3.14159 and e is 2.71828 ok", 18)),
        JSON.stringify(["pi is 3.14159 and", "e is 2.71828 ok"]), "小数点不是断句点，按空白切");
    eq(JSON.stringify(T.splitText("First one. Second one. Third.", 24)),
        JSON.stringify(["First one. Second one.", "Third."]), "英文句号后面跟空白才算句末");
    eq(JSON.stringify(T.splitText("aaaa &amp; bbbb &amp; cccc", 18)),
        JSON.stringify(["aaaa &amp; bbbb", "&amp; cccc"]), "实体结尾的分号不当作句末标点");
    eq(JSON.stringify(T.splitText("一二三四五六七八九十", 16)),
        JSON.stringify(["一二三四五", "六七八九十"]), "无处可切时按字节上限硬切在字符边界");
    eq(JSON.stringify(T.splitText("1. First item here\n2. Second item here\n3. Third item here", 22)),
        JSON.stringify(["1. First item here", "2. Second item here", "3. Third item here"]),
        "换行优先于句点：有序列表的编号不会被切到上一段末尾");
    eq(JSON.stringify(T.splitText("第一行内容\n第二。第三。", 27)),
        JSON.stringify(["第一行内容", "第二。第三。"]), "后半段同时有换行和句号时在换行处切");
    eq(JSON.stringify(T.splitText("第一句。第二句\n第三句。", 27)),
        JSON.stringify(["第一句。第二句", "第三句。"]), "换行在后半段时优先于前半段的句号");

    // 8. 二进制帧解析
    var audio = fakeAudio(720);
    var frame = T.parseBinaryFrame(binaryFrame(AUDIO_HEADER, audio));
    ok(frame.ok && frame.path === "audio" && frame.contentType === "audio/mpeg", "音频帧：Path 与 Content-Type");
    eq(frame.audioStart, 2 + AUDIO_HEADER.length, "音频从 2+N 开始");
    eq(frame.audioLength, 720, "音频长度 = 帧长 - 2 - N");
    eq(frame.headers["x-streamid"], "1E708CCA91694AA5B8939B0B6CED7DCE", "头文本按行解析，键名不分大小写");
    frame = T.parseBinaryFrame(binaryFrame(END_HEADER, []));
    ok(frame.ok && frame.path === "audio" && frame.contentType === "" && frame.audioLength === 0,
        "结束帧：有 Path:audio，无 Content-Type，无数据");
    var bigHeader = AUDIO_HEADER + "X-Padding:" + repeat("p", 300) + "\r\n";
    frame = T.parseBinaryFrame(binaryFrame(bigHeader, [1, 2, 3]));
    ok(frame.ok && frame.audioStart === 2 + bigHeader.length && frame.audioLength === 3 && bigHeader.length > 255,
        "头长度超过 255 时按大端两字节解析");
    ok(!T.parseBinaryFrame([]).ok && !T.parseBinaryFrame([0]).ok, "不足 2 字节的帧解析失败");
    ok(!T.parseBinaryFrame([0, 10, 65, 66]).ok, "头长度超过帧长度时解析失败");
    ok(!T.parseBinaryFrame(null).ok, "空帧解析失败");
    frame = T.parseBinaryFrame([0, 0, 1, 2]);
    ok(frame.ok && frame.path === "" && frame.audioLength === 2, "头长度为 0 的帧能解析，但没有 Path");

    var textParsed = T.parseTextFrame(textFrame("turn.end", "{}"));
    ok(textParsed.path === "turn.end" && textParsed.body === "{}", "文本帧解析出 Path 与正文");
    eq(T.parseTextFrame("Path:audio.metadata\r\nX:1").path, "audio.metadata", "没有正文的文本帧也能取到 Path");

    // 9. $data 取字节：toByteArray -> toHex -> toBase64
    var sample = [0, 1, 2, 250, 251, 255, 128, 64];
    eq(JSON.stringify(T.dataToBytes(makeData(sample))), JSON.stringify(sample), "优先用 toByteArray");
    eq(JSON.stringify(T.dataToBytes(makeData(sample, "hex"))), JSON.stringify(sample), "没有 toByteArray 时用 toHex");
    eq(JSON.stringify(T.dataToBytes(makeData(sample, "base64"))), JSON.stringify(sample),
        "只有 toBase64 时解码 base64");
    eq(JSON.stringify(T.dataToBytes(makeData([1, 2], "base64"))), JSON.stringify([1, 2]), "base64 带填充也能解码");
    ok(makeData(sample).length === undefined, "桩 $data 没有 length，与真机一致");
    var threw = false;
    try {
        T.dataToBytes({});
    } catch (err) {
        threw = true;
    }
    ok(threw, "没有任何取字节方法时抛出异常");

    // 10. 流式 base64
    var all = [];
    for (i = 0; i < 256; i++) {
        all.push(i);
    }
    var sink = new T.Base64Sink();
    sink.append(all, 0, all.length);
    eq(sink.finish(), base64(all), "一次喂完 256 字节");
    var sinkOk = true;
    for (var size = 0; size <= 40; size++) {
        var data = fakeAudio(size);
        var pieceSink = new T.Base64Sink();
        var offset = 0;
        while (offset < data.length) {
            var step = 1 + random(7);
            var padded = [9, 9].concat(data.slice(offset, offset + step));
            pieceSink.append(padded, 2, padded.length);
            offset += step;
        }
        if (pieceSink.finish() !== base64(data) || pieceSink.byteCount !== data.length) {
            sinkOk = false;
        }
    }
    ok(sinkOk, "任意切分方式喂入，结果都与整体编码一致（长度 0–40）");
    sink = new T.Base64Sink();
    sink.append([0xff], 0, 1);
    sink.append([0xf3, 0x64, 0xc4, 0x00], 0, 4);
    eq(JSON.stringify(sink.head), JSON.stringify([0xff, 0xf3, 0x64, 0xc4]), "记录整段音频最开头的 4 个字节");

    // 11. 音色名称
    eq(T.toVoiceName("zh-CN-XiaoxiaoNeural"), XIAOXIAO_FULL, "ShortName 转成 Edge 发送的完整名称");
    eq(T.toVoiceName("zh-CN-liaoning-XiaobeiNeural"),
        "Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)", "方言音色以最后一个连字符为界");
    eq(T.toVoiceName("fil-PH-BlessicaNeural"),
        "Microsoft Server Speech Text to Speech Voice (fil-PH, BlessicaNeural)", "三字母语言代码");
    eq(T.toVoiceName(XIAOXIAO_FULL), XIAOXIAO_FULL, "已经是完整名称时原样使用");
    ok(T.isValidVoice("en-US-AvaMultilingualNeural") && T.isValidVoice("iu-Latn-CA-SiqiniqNeural") &&
        T.isValidVoice(XIAOXIAO_FULL), "合法的音色名称");
    ok(!T.isValidVoice("x' onload='1") && !T.isValidVoice("zh-CN-Xiaoxiao Neural") && !T.isValidVoice("晓晓") &&
        !T.isValidVoice("<voice>") && !T.isValidVoice(""), "带引号、空格、尖括号或中文的名称被拒绝");

    // 12. 音色优先级：customVoice > 语言覆盖 > 全局 > 内置表
    reset();
    r = T.resolveVoice("zh-Hans");
    ok(r.voice === "zh-CN-XiaoxiaoNeural" && r.source === "table", "默认设置下用内置表");
    r = T.resolveVoice("fr");
    ok(r.voice === "fr-FR-DeniseNeural" && r.source === "table", "没有覆盖菜单的语言用内置表");
    eq(T.resolveVoice("tlh"), null, "表外语言解析不出音色");

    reset({ voiceMode: "global", globalVoice: "en-US-AvaMultilingualNeural" });
    r = T.resolveVoice("zh-Hans");
    ok(r.voice === "en-US-AvaMultilingualNeural" && r.source === "global", "全局固定优先于内置表");
    r = T.resolveVoice("tlh");
    ok(r.voice === "en-US-AvaMultilingualNeural" && r.source === "global", "全局固定时表外语言也用全局音色");

    reset({ voiceMode: "global", globalVoice: "en-US-AvaMultilingualNeural", voiceZhHans: "zh-CN-YunxiNeural" });
    r = T.resolveVoice("zh-Hans");
    ok(r.voice === "zh-CN-YunxiNeural" && r.source === "override", "语言覆盖优先于全局固定");
    r = T.resolveVoice("en");
    ok(r.voice === "en-US-AvaMultilingualNeural" && r.source === "global", "没有指定覆盖的语言仍用全局音色");

    reset({ voiceJa: "ja-JP-KeitaNeural" });
    r = T.resolveVoice("ja");
    ok(r.voice === "ja-JP-KeitaNeural" && r.source === "override", "按语言自动时语言覆盖优先于内置表");
    ok(T.resolveVoice("ko").voice === "ko-KR-SunHiNeural", "日语的覆盖不影响韩语");

    reset({
        customVoice: "  fr-FR-HenriNeural  ",
        voiceMode: "global",
        globalVoice: "en-US-AvaMultilingualNeural",
        voiceZhHans: "zh-CN-YunxiNeural"
    });
    r = T.resolveVoice("zh-Hans");
    ok(r.voice === "fr-FR-HenriNeural" && r.source === "custom", "自定义音色优先级最高且被 trim");
    ok(T.resolveVoice("tlh").voice === "fr-FR-HenriNeural", "填了自定义音色时表外语言也能朗读");

    reset({ voiceMode: "global", globalVoice: "" });
    eq(T.resolveVoice("en").voice, "en-US-EmmaMultilingualNeural", "全局音色为空时回落到默认的 Multilingual 音色");
    globalThis.$option = {};
    eq(T.resolveVoice("en").voice, "en-US-AriaNeural", "选项全部缺失时按语言自动");
    [["zh-Hans", "voiceZhHans"], ["zh-Hant", "voiceZhHant"], ["yue", "voiceYue"], ["en", "voiceEn"],
        ["ja", "voiceJa"], ["ko", "voiceKo"]].forEach(function (pair) {
        var overrides = {};
        overrides[pair[1]] = "en-GB-SoniaNeural";
        reset(overrides);
        ok(T.resolveVoice(pair[0]).voice === "en-GB-SoniaNeural" && T.resolveVoice(pair[0]).source === "override",
            pair[0] + " 读取选项 " + pair[1]);
    });

    // 13. 语速 / 音调 / 音量
    reset({ rate: "+25%", pitch: "-10Hz", volume: "-30%" });
    eq(JSON.stringify(T.resolveProsody()), JSON.stringify({ rate: "+25%", pitch: "-10Hz", volume: "-30%" }),
        "读取语速 / 音调 / 音量");
    reset({ rate: "fast", pitch: "+10%", volume: "'/><x" });
    eq(JSON.stringify(T.resolveProsody()), JSON.stringify({ rate: "+0%", pitch: "+0Hz", volume: "+0%" }),
        "格式不对的值回落到默认，不会进入 SSML");
    globalThis.$option = {};
    eq(JSON.stringify(T.resolveProsody()), JSON.stringify({ rate: "+0%", pitch: "+0Hz", volume: "+0%" }),
        "选项缺失时用默认值");

    // 14. 状态机：成功
    reset();
    audio = fakeAudio(720 * 3 + 100);
    socketScripts.push(successScript(audio, 720));
    r = speak(ZH);
    eq(r.length, 1, "成功：completion 调用一次");
    ok(r[0].result && r[0].result.type === "base64" && r[0].error === undefined, "成功：返回 base64 结果");
    eq(r[0].result.value, base64(audio), "成功：音频等于各帧音频按顺序拼接");
    ok(r[0].result.raw.voice === "zh-CN-XiaoxiaoNeural" && r[0].result.raw.segments === 1 &&
        r[0].result.raw.bytes === audio.length && r[0].result.raw.format === "mp3", "成功：raw 记录音色、段数、字节数");
    eq(sockets.length, 1, "成功：只建了一条连接");
    eq(sockets[0].params.timeoutInterval, 30, "连接的 timeoutInterval 是 30 秒");
    ok(sockets[0].params.header && sockets[0].params.headers === undefined, "握手头用 header 参数（单数）");
    ok(/^muid=[0-9A-F]{32};$/.test(sockets[0].params.header.Cookie) &&
        sockets[0].params.header["User-Agent"].indexOf("Edg/143") > 0, "握手头带 Edge 的 UA 和 MUID");
    ok(serverAccepts(sockets[0].params.url), "URL 里的签名能通过服务端校验");
    eq(sockets[0].sent.length, 2, "连上后发两条文本帧");
    ok(sockets[0].sent[0].indexOf("Path:speech.config\r\n") > 0, "第一条是 speech.config");
    ok(ssmlOf(sockets[0]).indexOf("Path:ssml\r\n") > 0 &&
        ssmlOf(sockets[0]).indexOf("<voice name='" + XIAOXIAO_FULL + "'>") > 0 &&
        ssmlOf(sockets[0]).indexOf(">你好，世界</prosody>") > 0, "第二条是 ssml，带完整音色名和文本");
    eq(sockets[0].closeCalls, 1, "成功后关闭连接");
    eq(sockets[0].closeArgTypes[0], "object", "close 传入对象参数（Bob 1.21.0 不带参数会记未捕获异常）");
    eq(activeTimers(), 0, "成功后定时器被取消");
    eq(T.activeSocketCount(), 0, "成功后不再持有 socket");
    eq(timers.length, 1, "顺利合成时每条连接只挂过一个定时器");
    ok(timers[0].interval <= 10 && timers[0].interval > 9.9 && timers[0].repeats === false,
        "看门狗先按 10 秒的握手期限上弦、不重复");
    eq(sockets[0].params.timeoutInterval, 30, "传给 Bob 的 timeoutInterval 是 30 秒");
    ok(loggedLine("done voice=zh-CN-XiaoxiaoNeural(table)") && loggedLine("segments=1") &&
        loggedLine("bytes=" + audio.length) && loggedLine(" ms="), "日志记录音色、段数、字节数、耗时");
    ok(!logs.some(function (l) { return l.indexOf("你好") >= 0 || l.indexOf("世界") >= 0; }), "日志不包含朗读的文本");

    // 成功之后迟到的事件不会再触发 completion
    sockets[0].fireText(textFrame("turn.end"));
    sockets[0].fireError({ code: 1, message: "late" });
    sockets[0].fireClose(1006, "late");
    sockets[0].fireOpen();
    fireTimer(timers[0]);
    timers[0].handler();
    eq(r.length, 1, "成功之后迟到的 turn.end / error / close / 超时都被忽略");
    eq(sockets[0].sent.length, 2, "迟到的 open 不会重复发送消息");
    eq(sockets[0].closeCalls, 1, "连接只关闭一次");

    // 15. 状态机：SSML 转义、韵律、$data 回退路径
    reset({ rate: "+20%", pitch: "-10Hz", volume: "+10%", voiceEn: "en-GB-SoniaNeural" });
    audio = fakeAudio(1000);
    socketScripts.push(successScript(audio, 333, "base64"));
    r = speak({ text: "  Tom & Jerry <3 \u000b\"quotes\" > all  ", lang: "en" });
    ok(r.length === 1 && r[0].result && r[0].result.value === base64(audio),
        "$data 只有 toBase64 时也能正确取出音频");
    ok(ssmlOf(sockets[0]).indexOf(">Tom &amp; Jerry &lt;3  \"quotes\" &gt; all</prosody>") > 0,
        "朗读文本经过清理、转义并去掉首尾空白");
    ok(ssmlOf(sockets[0]).indexOf("<prosody pitch='-10Hz' rate='+20%' volume='+10%'>") > 0, "语速音调音量写进 prosody");
    ok(ssmlOf(sockets[0]).indexOf("(en-GB, SoniaNeural)") > 0, "英语用覆盖菜单选的音色");
    eq(r[0].result.raw.voice_source, "override", "raw 记录音色来源");

    reset();
    socketScripts.push(successScript(fakeAudio(500), 100, "hex"));
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && r[0].result.raw.bytes === 500, "$data 只有 toHex 时也能正确取出音频");

    // 16. 状态机：分段合成与拼接
    reset();
    var first = fakeAudio(2000);
    var second = fakeAudio(1500);
    var third = fakeAudio(701);
    socketScripts.push(successScript(first, 720), successScript(second, 720), successScript(third, 720));
    var paragraph = repeat("这是一段用来测试分段合成的文字，包含 English words 和标点。", 90);
    ok(utf8Bytes(paragraph).length > 6000 && utf8Bytes(paragraph).length < 9000, "构造 6000–9000 字节的文本");
    r = speak({ text: paragraph, lang: "zh-Hans" });
    eq(r.length, 1, "分段：completion 调用一次");
    eq(sockets.length, 3, "分段：每段新开一条连接");
    eq(r[0].result.value, base64(first.concat(second, third)), "分段：各段 mp3 按顺序首尾拼接");
    ok(r[0].result.raw.segments === 3 && r[0].result.raw.bytes === 4201, "分段：raw 里是 3 段、总字节数");
    var spoken = sockets.map(function (sock) {
        var m = /<prosody[^>]*>([\s\S]*)<\/prosody>/.exec(ssmlOf(sock));
        return m ? m[1] : "";
    });
    ok(spoken.every(function (seg) { return seg && utf8Bytes(seg).length <= 3000; }), "分段：每条 ssml 的文本不超过 3000 字节");
    eq(stripSpace(spoken.join("")), stripSpace(paragraph), "分段：各段文本拼起来就是原文");
    ok(sockets.every(function (sock) { return sock.closeCalls === 1 && sock.openCalls === 1; }), "分段：每条连接都打开并关闭一次");
    ok(sockets[0].params.url !== sockets[1].params.url &&
        sockets[0].params.header.Cookie !== sockets[1].params.header.Cookie, "分段：每条连接的 ConnectionId 与 MUID 都不同");
    ok(loggedLine("segments=3") && loggedLine("bytes=4201"), "分段：日志记录段数与总字节数");
    eq(activeTimers(), 0, "分段：结束后没有残留的定时器");

    // 17. 状态机：握手 error
    reset();
    socketScripts.push(rejectScript, rejectScript);
    httpResponder = httpDateResponder("Date");
    r = speak(ZH);
    eq(r.length, 1, "握手失败：completion 调用一次");
    ok(r[0].error && r[0].error.type === "api", "握手失败映射为 api");
    eq(r[0].error.message, "微软接口拒绝连接，请检查系统时间；若持续失败请更新插件", "握手失败的提示语");
    eq(sockets.length, 2, "握手失败：重签后只重试一次");
    eq(httpRequests.length, 1, "握手失败：请求一次音色列表来对时");
    ok(httpRequests[0].url === config.VOICE_LIST_URL && httpRequests[0].method === "GET", "对时请求的是音色列表地址");
    ok(r[0].error.addtion && r[0].error.addtion.kind === "handshake" && r[0].error.addtion.error.code === 403 &&
        r[0].error.addtion.clockProbe && r[0].error.addtion.clockProbe.reachable === true,
        "握手失败：addtion 带上 error 对象与对时结果");
    eq(JSON.stringify(r[0].error.addition), JSON.stringify(r[0].error.addtion), "addtion 与 addition 两个键内容相同");
    ok(sockets.every(function (sock) { return sock.closeCalls === 1; }) && activeTimers() === 0 &&
        T.activeSocketCount() === 0, "握手失败：连接与定时器都已清理");
    ok(loggedLine("failed type=api kind=handshake"), "握手失败写 failed 日志");

    // 握手时只来 close 没来 error，也算握手失败
    reset();
    socketScripts.push(function (socket) { socket.fireClose(1006, ""); }, successScript(fakeAudio(300), 720));
    httpResponder = httpDateResponder("Date");
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && sockets.length === 2, "握手阶段直接被关闭也会触发一次重试");

    // 18. 时钟偏差兜底
    [["Date", 600], ["date", -600], ["DATE", 3600]].forEach(function (item) {
        reset();
        clockOffset = item[1] * 1000;
        audio = fakeAudio(900);
        socketScripts.push(edgeServerScript(audio), edgeServerScript(audio), edgeServerScript(audio));
        httpResponder = httpDateResponder(item[0]);
        r = speak(ZH);
        var label = "本机时钟偏 " + item[1] + " 秒（响应头键名 " + item[0] + "）";
        ok(r.length === 1 && r[0].result && r[0].result.value === base64(audio), label + "：重签后合成成功");
        ok(sockets.length === 2 && httpRequests.length === 1, label + "：第一次握手被拒，对时一次，重试一次");
        ok(!serverAccepts(sockets[0].params.url) && serverAccepts(sockets[1].params.url), label + "：第二次的签名按服务器时间计算");
        ok(Math.abs(T.getClockSkewMs() + item[1] * 1000) < 2000, label + "：记住测得的偏差");
        ok(loggedLine("本机时钟与服务器相差"), label + "：日志记录偏差");
        r = speak(ZH);
        ok(r.length === 1 && r[0].result && sockets.length === 3 && httpRequests.length === 1,
            label + "：之后的朗读直接带着偏差签名，不再对时");
    });

    // 偏差在容忍范围内时不需要兜底
    reset();
    clockOffset = 200 * 1000;
    socketScripts.push(edgeServerScript(fakeAudio(300)));
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && sockets.length === 1 && httpRequests.length === 0, "时钟偏 200 秒仍在相邻窗口内，一次成功");

    // 连音色列表都请求不到：是网络问题，不是被拒
    reset();
    socketScripts.push(rejectScript);
    httpResponder = function () {
        return { error: { message: "The Internet connection appears to be offline." }, response: null };
    };
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "network", "握手失败且音色列表也请求不到：映射为 network");
    ok(sockets.length === 1 && r[0].error.addtion.clockProbe.reachable === false &&
        r[0].error.addtion.clockProbe.error.message.indexOf("offline") > 0, "网络不通时不再重试，addtion 带上原因");

    // 音色列表没有 Date 头：照原时间重试一次
    reset();
    socketScripts.push(rejectScript, successScript(fakeAudio(300), 720));
    httpResponder = function () {
        return { response: { statusCode: 200, headers: {} }, data: [] };
    };
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && sockets.length === 2 && T.getClockSkewMs() === 0,
        "拿不到 Date 头时仍重试一次，偏差保持 0");

    // 分段时第二段握手失败：整次朗读只兜底一次
    reset();
    socketScripts.push(rejectScript, successScript(fakeAudio(300), 720), rejectScript);
    httpResponder = httpDateResponder("Date");
    r = speak({ text: paragraph, lang: "zh-Hans" });
    ok(r.length === 1 && r[0].error && r[0].error.type === "api" && sockets.length === 3 && httpRequests.length === 1,
        "整次朗读只做一次重签重试");
    ok(r[0].error.addtion.segment === 2 && r[0].error.addtion.segments === 3, "addtion 指出失败的是第几段");

    eq(T.parseHttpDate("Sun, 27 Sep 2026 03:10:14 GMT"), 1790478614000, "解析 HTTP Date 头");
    eq(T.parseHttpDate("Thu, 01 Jan 1970 00:00:00 GMT"), 0, "解析 1970-01-01");
    ok(isNaN(T.parseHttpDate("")) && isNaN(T.parseHttpDate("yesterday")) &&
        isNaN(T.parseHttpDate("Sun, 27 Foo 2026 03:10:14 GMT")), "无法解析的 Date 返回 NaN");

    // 19. 状态机：超时
    reset();
    socketScripts.push(openOnlyScript);
    r = speak(ZH);
    eq(r.length, 0, "超时：收不到 turn.end 时先不回调");
    eq(activeTimers(), 1, "超时：定时器在等待");
    eq(T.activeSocketCount(), 1, "超时：等待期间持有 socket");
    sockets[0].fireText(textFrame("turn.start"));
    sockets[0].fireData(makeData(binaryFrame(AUDIO_HEADER, fakeAudio(720))));
    eq(r.length, 0, "超时：收到部分音频但没有 turn.end，仍不回调");
    ok(fireActiveTimer() && r.length === 0 && activeTimers() === 1, "超时：期限没到时看门狗只会重新上弦");
    clockOffset += 30001;
    ok(fireActiveTimer(), "超时：30 秒到点");
    eq(r.length, 1, "超时：定时器触发后回调一次，不会挂死");
    ok(r[0].error && r[0].error.type === "network" && r[0].error.message.indexOf("超时") > 0, "超时映射为 network");
    ok(r[0].error.addtion.kind === "timeout" && r[0].error.addtion.timeoutSeconds === 30 &&
        r[0].error.addtion.audioBytes === 720, "超时：addtion 记录超时秒数与已收到的字节数");
    ok(sockets[0].closeCalls === 1 && T.activeSocketCount() === 0, "超时后关闭连接");
    eq(httpRequests.length, 0, "超时不触发时钟兜底");
    sockets[0].fireText(textFrame("turn.end"));
    sockets[0].fireClose(1000, "");
    eq(r.length, 1, "超时之后迟到的 turn.end 被忽略");

    // 握手一直没有结果（open 都没来）。真机上连接被拒、域名解析失败时 Bob 不给任何回调
    reset();
    r = speak(ZH);
    ok(r.length === 0 && sockets.length === 1 && sockets[0].openCalls === 1, "握手没有结果时等待");
    clockOffset += 5000;
    ok(fireActiveTimer() && r.length === 0 && activeTimers() === 1, "握手超时：没到 10 秒时看门狗只会重新上弦");
    clockOffset += 5001;
    ok(fireActiveTimer(), "握手超时：10 秒到点");
    ok(r.length === 1 && r[0].error.type === "network" && r[0].error.addtion.opened === false, "握手阶段超时同样映射为 network");
    ok(r[0].error.addtion.kind === "connectTimeout" && r[0].error.addtion.openTimeoutSeconds === 10 &&
        r[0].error.message.indexOf("连接不上微软语音服务") === 0, "握手超时提示检查网络，并注明等了 10 秒");
    ok(sockets[0].closeCalls === 1 && activeTimers() === 0 && T.activeSocketCount() === 0, "握手超时后关闭连接、不留定时器");
    ok(sockets.length === 1 && httpRequests.length === 0, "握手超时不重试，也不触发时钟兜底");

    // 握手之后服务端不吭声。真机上 TCP 被掐断、服务端沉默时 Bob 同样不给任何回调
    reset();
    socketScripts.push(openOnlyScript);
    r = speak(ZH);
    sockets[0].fireText(textFrame("turn.start"));
    clockOffset += 9000;
    sockets[0].fireData(makeData(binaryFrame(AUDIO_HEADER, fakeAudio(720))));
    clockOffset += 9000;
    ok(fireActiveTimer() && r.length === 0 && activeTimers() === 1, "空闲超时：距上一帧不到 15 秒时只会重新上弦");
    clockOffset += 6001;
    ok(fireActiveTimer(), "空闲超时：距上一帧 15 秒到点");
    ok(r.length === 0 && sockets.length === 2 && sockets[0].closeCalls === 1 && activeTimers() === 1,
        "空闲超时属于瞬时故障：关掉这条连接，换一条重试");
    ok(loggedLine("stalled 失败") && loggedLine("第 1 次重试"), "空闲超时：日志记录重试");
    audio = fakeAudio(720);
    sockets[1].fireOpen();
    sockets[1].fireData(makeData(binaryFrame(AUDIO_HEADER, audio)));
    sockets[1].fireText(textFrame("turn.end"));
    ok(r.length === 1 && r[0].result && r[0].result.value === base64(audio) && r[0].result.raw.retries === 1,
        "空闲超时：重试成功，丢掉第一条连接的残缺音频，raw 记录重试次数");
    eq(httpRequests.length, 0, "空闲超时不触发时钟兜底");

    // 连续三条连接都没数据：两次重试用完后按空闲超时报错
    reset();
    socketScripts.push(openOnlyScript, openOnlyScript, openOnlyScript);
    r = speak(ZH);
    for (i = 0; i < 3; i++) {
        clockOffset += 15001;
        fireActiveTimer();
    }
    ok(r.length === 1 && r[0].error && r[0].error.type === "network" && r[0].error.addtion.kind === "stalled" &&
        r[0].error.addtion.idleSeconds === 15 && r[0].error.addtion.retries === 2 && sockets.length === 3,
        "空闲超时：两次重试仍失败时映射为 network，addtion 记录重试次数");
    ok(r[0].error.message.indexOf("连接中断") > 0 && r[0].error.addtion.opened === true &&
        sockets.every(function (sock) { return sock.closeCalls === 1; }) && activeTimers() === 0,
        "空闲超时：提示连接中断，三条连接都已关闭");

    // 一直有数据进来就不算空闲，最终由 30 秒的总期限收场
    reset();
    socketScripts.push(openOnlyScript);
    r = speak(ZH);
    for (var tick = 0; tick < 5; tick++) {
        clockOffset += 5900;
        sockets[0].fireData(makeData(binaryFrame(AUDIO_HEADER, fakeAudio(720))));
        fireActiveTimer();
    }
    ok(r.length === 0 && activeTimers() === 1, "持续收到数据时不会误判为空闲");
    clockOffset += 600;
    fireActiveTimer();
    ok(r.length === 1 && r[0].error.addtion.kind === "timeout" && r[0].error.addtion.audioBytes === 3600,
        "持续收到数据但 30 秒内没有 turn.end 时按总超时处理");

    // 20. 状态机：turn.end 但没有音频
    reset();
    socketScripts.push(noAudioScript, noAudioScript);
    r = speak({ text: "你好", lang: "en" });
    eq(r.length, 1, "无音频：completion 调用一次");
    ok(r[0].error && r[0].error.type === "api", "无音频映射为 api");
    eq(r[0].error.message, "未返回音频，请换个音色重试", "无音频的提示语");
    ok(r[0].error.addtion.kind === "noAudio" && r[0].error.addtion.voice === "en-US-AriaNeural" &&
        r[0].error.addtion.binaryFrames === 1, "无音频：addtion 记录音色与帧数");
    ok(sockets.length === 2 && r[0].error.addtion.retries === 1 && httpRequests.length === 0,
        "无音频且没有可回退的音色：同一音色只重试一次，不触发时钟兜底");

    // 21. 状态机：服务端中途关闭
    reset({ customVoice: "zh-CN-NoSuchVoiceNeural" });
    socketScripts.push(closeScript(1007, "Unsupported voice zh-CN-NoSuchVoiceNeural."));
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "param" &&
        r[0].error.message.indexOf("zh-CN-NoSuchVoiceNeural") > 0, "音色不存在（1007 Unsupported voice）映射为 param");
    ok(r[0].error.addtion.closeCode === 1007 && r[0].error.addtion.closeReason.indexOf("Unsupported voice") === 0,
        "addtion 记录关闭码与原因");

    reset();
    socketScripts.push(closeScript(1011, "Internal server error"), closeScript(1011, "Internal server error"),
        closeScript(1011, "Internal server error"));
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "api" &&
        r[0].error.message.indexOf("Internal server error") > 0, "其他原因的中途关闭映射为 api 并带出原因");
    ok(sockets.length === 3 && r[0].error.addtion.retries === 2, "中途关闭最多重试两次");

    var streamErrorScript = function (socket) {
        socket.fireOpen();
        socket.fireData(makeData(binaryFrame(AUDIO_HEADER, fakeAudio(720))));
        socket.fireError({ code: 57, message: "Socket is not connected" });
        socket.fireClose(1006, "");
    };
    reset();
    socketScripts.push(streamErrorScript, streamErrorScript, streamErrorScript);
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "network" && r[0].error.addtion.kind === "stream" &&
        sockets.length === 3, "合成途中连接出错：两次重试仍失败映射为 network，不返回残缺音频");
    eq(httpRequests.length, 0, "连接建立之后的错误不触发时钟兜底");

    // 22. 异常帧不影响正常音频
    reset();
    audio = fakeAudio(1440);
    socketScripts.push(function (socket) {
        socket.fireOpen();
        socket.fireData(makeData([0]));
        socket.fireData(makeData([0, 200, 65, 66]));
        socket.fireData(makeData(binaryFrame("Path:other\r\nContent-Type:audio/mpeg\r\n", [1, 2, 3])));
        socket.fireData(makeData(binaryFrame("Path:audio\r\nContent-Type:application/json\r\n", [1, 2, 3])));
        socket.fireData(makeData(binaryFrame(END_HEADER, [1, 2, 3])));
        socket.fireData(makeData(binaryFrame(AUDIO_HEADER, [])));
        socket.fireText(textFrame("some.future.path"));
        socket.fireData(makeData(binaryFrame(AUDIO_HEADER, audio.slice(0, 720))));
        socket.fireData(makeData(binaryFrame(AUDIO_HEADER, audio.slice(720))));
        socket.fireText(textFrame("turn.end"));
    });
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && r[0].result.value === base64(audio),
        "残帧、Path 不对、类型不对、空音频帧都被忽略，只拼接真正的音频");

    // 回调里抛异常也要回调 completion
    reset();
    socketScripts.push(function (socket) {
        socket.fireOpen();
        socket.fireData({ __data: true });
    });
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "unknown" && sockets[0].closeCalls === 1,
        "处理帧时抛异常：回调 unknown 错误并关闭连接");

    // 23. 参数校验
    reset();
    r = speak({ text: "   ", lang: "en" });
    ok(r.length === 1 && r[0].error && r[0].error.type === "param" && sockets.length === 0, "空文本报 param，不建连接");
    r = speak({ text: "\u0001\u0002", lang: "en" });
    ok(r.length === 1 && r[0].error && r[0].error.type === "param" && sockets.length === 0, "只有控制字符的文本报 param");
    r = speak({ text: "nuqneH", lang: "tlh" });
    ok(r.length === 1 && r[0].error && r[0].error.type === "unsupportLanguage" && sockets.length === 0,
        "语言不在表内报 unsupportLanguage");
    ok(r[0].error.addtion && r[0].error.addtion.lang === "tlh", "unsupportLanguage 的 addtion 带上语言代码");
    r = speak(null);
    ok(r.length === 1 && r[0].error && r[0].error.type === "param", "query 为空时报 param");

    reset({ customVoice: "x' /><break time='9s'/><voice name='y" });
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "param" && sockets.length === 0,
        "自定义音色格式不对时报 param，不会把它拼进 SSML");

    reset({ customVoice: "fr-FR-HenriNeural" });
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = speak({ text: "nuqneH", lang: "tlh" });
    ok(r.length === 1 && r[0].result && ssmlOf(sockets[0]).indexOf("(fr-FR, HenriNeural)") > 0,
        "填了自定义音色后表外语言也能朗读");

    // 24. 总预算：Bob 的 60 秒超时之前必须给出结果
    reset();
    socketScripts.push(function (socket) {
        successScript(fakeAudio(300), 720)(socket);
    }, function (socket) {
        clockOffset += 56000;
        successScript(fakeAudio(300), 720)(socket);
    });
    r = speak({ text: paragraph, lang: "zh-Hans" });
    ok(r.length === 1 && r[0].error && r[0].error.type === "network" && r[0].error.addtion.kind === "budget",
        "多段合成超过 55 秒总预算时报 network，而不是等 Bob 超时");
    eq(sockets.length, 2, "预算用完后不再新建连接");

    reset();
    socketScripts.push(function (socket) {
        clockOffset += 40000;
        successScript(fakeAudio(300), 720)(socket);
    }, openOnlyScript);
    r = speak({ text: paragraph, lang: "zh-Hans" });
    ok(r.length === 0 && sockets[1].params.timeoutInterval <= 15 && sockets[1].params.timeoutInterval >= 14,
        "剩余预算不足 30 秒时，连接超时随之缩短");
    sockets[1].fireData(makeData(binaryFrame(AUDIO_HEADER, fakeAudio(720))));
    clockOffset += 14000;
    sockets[1].fireData(makeData(binaryFrame(AUDIO_HEADER, fakeAudio(720))));
    clockOffset += 1001;
    fireActiveTimer();
    ok(r.length === 1 && r[0].error.type === "network" && r[0].error.addtion.kind === "timeout" &&
        r[0].error.addtion.timeoutSeconds <= 15, "缩短后的超时触发时回调 network");

    // 25. 没有 $timer / $websocket 的运行时
    reset();
    var savedTimer = globalThis.$timer;
    globalThis.$timer = undefined;
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = speak(ZH);
    globalThis.$timer = savedTimer;
    ok(r.length === 1 && r[0].result, "没有 $timer 时仍能合成（只是少了插件自己的超时兜底）");

    reset();
    var savedSocket = globalThis.$websocket;
    globalThis.$websocket = undefined;
    r = speak(ZH);
    globalThis.$websocket = savedSocket;
    ok(r.length === 1 && r[0].error && r[0].error.type === "unknown" && r[0].error.message.indexOf("$websocket") > 0,
        "没有 $websocket 时给出明确错误");

    reset();
    globalThis.$websocket = {
        new: function () {
            throw new Error("boom");
        }
    };
    r = speak(ZH);
    globalThis.$websocket = savedSocket;
    ok(r.length === 1 && r[0].error && r[0].error.type === "unknown" && r[0].error.message.indexOf("boom") > 0,
        "$websocket.new 抛异常时回调 unknown 错误");

    // close() 不回调 listenClose 的运行时
    reset();
    echoCloseEvent = false;
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && sockets[0].closeCalls === 1, "close() 之后没有 close 事件时行为一致");

    // 26. pluginValidate
    reset();
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = validate();
    ok(r.length === 1 && r[0].result === true && r[0].error === undefined, "pluginValidate 合成成功时返回 result: true");
    ok(ssmlOf(sockets[0]).indexOf(">你好</prosody>") > 0 && ssmlOf(sockets[0]).indexOf(XIAOXIAO_FULL) > 0,
        "pluginValidate 默认用晓晓合成「你好」两个字");

    reset({ voiceMode: "global", globalVoice: "en-US-AvaMultilingualNeural" });
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = validate();
    ok(r[0].result === true && ssmlOf(sockets[0]).indexOf("(en-US, AvaMultilingualNeural)") > 0 &&
        ssmlOf(sockets[0]).indexOf(">Hi</prosody>") > 0, "全局固定时验证全局音色，非中文音色合成 Hi");

    reset({ voiceZhHans: "zh-CN-YunxiNeural" });
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = validate();
    ok(r[0].result === true && ssmlOf(sockets[0]).indexOf("(zh-CN, YunxiNeural)") > 0, "验证时尊重简体中文的覆盖菜单");

    reset({ customVoice: "zh-HK-HiuMaanNeural" });
    socketScripts.push(successScript(fakeAudio(300), 720));
    r = validate();
    ok(r[0].result === true && ssmlOf(sockets[0]).indexOf("(zh-HK, HiuMaanNeural)") > 0 &&
        ssmlOf(sockets[0]).indexOf(">你好</prosody>") > 0, "验证自定义的中文音色时合成「你好」");
    eq(T.validationSample(XIAOXIAO_FULL), "你好", "完整名称的中文音色也识别为中文");
    eq(T.validationSample("ja-JP-NanamiNeural"), "Hi", "其他语言的音色合成 Hi");

    reset();
    socketScripts.push(rejectScript, rejectScript);
    httpResponder = httpDateResponder("Date");
    r = validate();
    ok(r.length === 1 && r[0].result === false && r[0].error && r[0].error.type === "api",
        "pluginValidate 握手失败时返回 result: false 与错误");

    reset();
    socketScripts.push(noAudioScript, noAudioScript);
    r = validate();
    ok(r.length === 1 && r[0].result === false && r[0].error.message === "未返回音频，请换个音色重试" &&
        sockets.length === 2, "pluginValidate 无音频时同一音色重试一次后返回错误");

    reset({ customVoice: "not a voice" });
    r = validate();
    ok(r.length === 1 && r[0].result === false && r[0].error.type === "param", "pluginValidate 音色格式不对时报 param");

    reset();
    socketScripts.push(openOnlyScript);
    r = validate();
    ok(r.length === 0 && sockets[0].params.timeoutInterval <= 25, "pluginValidate 的超时比朗读更短");
    clockOffset += 25001;
    fireActiveTimer();
    fireActiveTimer();
    sockets[0].fireText(textFrame("turn.end"));
    ok(r.length === 1 && r[0].result === false && r[0].error.type === "network", "pluginValidate 超时只回调一次");

    // 27. 两次朗读互不干扰
    reset();
    socketScripts.push(openOnlyScript, openOnlyScript);
    var firstCall = speak(ZH);
    var secondCall = speak({ text: "hello", lang: "en" });
    var audioA = fakeAudio(720);
    var audioB = fakeAudio(360);
    sockets[1].fireData(makeData(binaryFrame(AUDIO_HEADER, audioB)));
    sockets[0].fireData(makeData(binaryFrame(AUDIO_HEADER, audioA)));
    sockets[1].fireText(textFrame("turn.end"));
    ok(firstCall.length === 0 && secondCall.length === 1 && secondCall[0].result.value === base64(audioB),
        "同时进行的两次朗读各自完成");
    sockets[0].fireText(textFrame("turn.end"));
    ok(firstCall.length === 1 && firstCall[0].result.value === base64(audioA) && T.activeSocketCount() === 0,
        "两次朗读的音频不会串");

    // 28. 瞬时故障重试
    reset();
    audio = fakeAudio(300);
    socketScripts.push(closeScript(1011, "Internal server error"), successScript(audio, 720));
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && r[0].result.value === base64(audio) && sockets.length === 2 &&
        r[0].result.raw.retries === 1, "1011 中途关闭：换一条连接重试后成功");
    ok(loggedLine("closed 失败") && loggedLine("第 1 次重试") && loggedLine("retries=1"), "重试与结果都写日志");

    reset();
    socketScripts.push(streamErrorScript, successScript(fakeAudio(300), 720));
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && sockets.length === 2, "合成途中出错：重试一次后成功");

    // 校时重签后仍是 5xx 算瞬时故障，再试；403 不再重试（见 17）
    var reject503 = function (socket) {
        socket.fireError({ code: 0, message: "notAnUpgrade(503)", type: "unknownError" });
    };
    reset();
    socketScripts.push(reject503, reject503, successScript(fakeAudio(300), 720));
    httpResponder = httpDateResponder("Date");
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && sockets.length === 3 && httpRequests.length === 1,
        "握手 503：校时重试后仍 503 再重试一次，第三次成功");

    reset();
    socketScripts.push(reject503, reject503, reject503, reject503);
    httpResponder = httpDateResponder("Date");
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.type === "api" && r[0].error.addtion.kind === "handshake" &&
        sockets.length === 4 && r[0].error.addtion.retries === 2, "握手一直 503：校时一次加两次重试后报错");

    reset();
    socketScripts.push(function (socket) {
        clockOffset += 51000;
        socket.fireOpen();
        socket.fireText(textFrame("turn.start"));
        socket.fireClose(1011, "Internal server error");
    }, successScript(fakeAudio(300), 720));
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.addtion.kind === "closed" && sockets.length === 1,
        "剩余预算不足 5 秒时不重试，直接报错");

    // 29. 音色读不了当前语言时回退到该语言的内置默认音色
    reset({ voiceMode: "global", globalVoice: "en-US-AriaNeural" });
    audio = fakeAudio(600);
    socketScripts.push(noAudioScript, successScript(audio, 720));
    r = speak(ZH);
    ok(r.length === 1 && r[0].result && r[0].result.value === base64(audio), "全局英文音色读中文无音频：回退后合成成功");
    ok(ssmlOf(sockets[0]).indexOf("(en-US, AriaNeural)") > 0 && ssmlOf(sockets[1]).indexOf(XIAOXIAO_FULL) > 0,
        "回退：第二条连接改用简体中文的默认音色");
    ok(r[0].result.raw.voice === "zh-CN-XiaoxiaoNeural" && r[0].result.raw.voice_source === "fallback" &&
        r[0].result.raw.retries === 1, "回退：raw 记录实际使用的音色与来源");
    ok(loggedLine("改用默认音色 zh-CN-XiaoxiaoNeural") && loggedLine("done voice=zh-CN-XiaoxiaoNeural(fallback)"),
        "回退写日志");

    reset({ customVoice: "en-GB-SoniaNeural" });
    socketScripts.push(noAudioScript, noAudioScript, noAudioScript);
    r = speak(ZH);
    ok(r.length === 1 && r[0].error && r[0].error.message === "未返回音频，请换个音色重试" && sockets.length === 3 &&
        r[0].error.addtion.voice === "zh-CN-XiaoxiaoNeural" && r[0].error.addtion.retries === 2,
        "回退音色也无音频：再试一次后报错，addtion 记录最后用的音色与重试次数");

    reset({ voiceMode: "global", globalVoice: "en-US-AriaNeural" });
    socketScripts.push(noAudioScript, successScript(fakeAudio(300), 720), successScript(fakeAudio(300), 720),
        successScript(fakeAudio(300), 720));
    r = speak({ text: paragraph, lang: "zh-Hans" });
    ok(r.length === 1 && r[0].result && sockets.length === 4 &&
        sockets.slice(1).every(function (sock) { return ssmlOf(sock).indexOf(XIAOXIAO_FULL) > 0; }),
        "分段：第一段回退后，后面的段直接用回退音色");

    reset({ customVoice: "fr-FR-HenriNeural" });
    socketScripts.push(noAudioScript, noAudioScript);
    r = speak({ text: "nuqneH", lang: "tlh" });
    ok(r.length === 1 && r[0].error && r[0].error.type === "api" && sockets.length === 2 &&
        ssmlOf(sockets[1]).indexOf("(fr-FR, HenriNeural)") > 0, "表外语言没有默认音色可回退，只用原音色重试一次");

    reset({ voiceMode: "global", globalVoice: "en-US-AriaNeural" });
    socketScripts.push(noAudioScript, noAudioScript);
    r = validate();
    ok(r.length === 1 && r[0].result === false && sockets.length === 2 &&
        sockets.every(function (sock) { return ssmlOf(sock).indexOf("(en-US, AriaNeural)") > 0; }),
        "pluginValidate 无音频时不回退到别的音色，验证的就是用户选的音色");

    print("");
    if (failures.length === 0) {
        print("ALL PASS (" + checks + " checks)");
    } else {
        print("FAILED " + failures.length + "/" + checks);
        failures.forEach(function (label) {
            print("  - " + label);
        });
    }
})();
