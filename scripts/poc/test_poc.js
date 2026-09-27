// PoC 的离线自测，用 macOS 自带的 jsc 跑（与 Bob 同一引擎），不联网：
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc scripts/poc/test_poc.js
// 在仓库根目录执行。桩掉 $websocket / $data / $http / $log / $timer / $env，
// $data 桩分「有 length」和「没有 length」两种，两种都要能拼出同样的音频。

var checks = 0;
var failures = [];

function ok(cond, name) {
    checks++;
    if (!cond) {
        failures.push(name);
        print("  FAIL " + name);
    }
}

function eq(got, want, name) {
    ok(got === want, name + " got=" + JSON.stringify(got) + " want=" + JSON.stringify(want));
}

// ---------------------------------------------------------------- 桩

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Of(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
        var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += B64.charAt(b0 >> 2);
        out += B64.charAt(((b0 & 3) << 4) | ((b1 || 0) >> 4));
        out += i + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | ((b2 || 0) >> 6)) : "=";
        out += i + 2 < bytes.length ? B64.charAt(b2 & 63) : "=";
    }
    return out;
}

function asciiBytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
        out.push(str.charCodeAt(i) & 255);
    }
    return out;
}

var exposeLength = true;
// 真机上 subData(start, end) 在 end 等于总长时拿不到数据，桩里用这个开关模拟
var subDataRejectsEnd = false;

function StubData(bytes) {
    this._bytes = bytes.slice();
    if (exposeLength) {
        Object.defineProperty(this, "length", {
            get: function () { return this._bytes.length; }
        });
    }
}
StubData.prototype.toByteArray = function () { return this._bytes.slice(); };
StubData.prototype.toHex = function (upper) {
    var out = "";
    for (var i = 0; i < this._bytes.length; i++) {
        out += ("0" + this._bytes[i].toString(16)).slice(-2);
    }
    return upper ? out.toUpperCase() : out;
};
StubData.prototype.toUTF8 = function () { return String.fromCharCode.apply(null, this._bytes); };
StubData.prototype.toBase64 = function () { return base64Of(this._bytes); };
StubData.prototype.readUInt8 = function (i) { return i >= 0 && i < this._bytes.length ? this._bytes[i] : 0; };
StubData.prototype.writeUInt8 = function (v, i) { if (i >= 0 && i < this._bytes.length) { this._bytes[i] = v & 255; } };
StubData.prototype.subData = function (start, end) {
    if (!(start >= 0) || !(end > start) || end > this._bytes.length) {
        return undefined;
    }
    if (subDataRejectsEnd && end === this._bytes.length) {
        return undefined;
    }
    return new StubData(this._bytes.slice(start, end));
};
StubData.prototype.appendData = function (other) { this._bytes = this._bytes.concat(other._bytes); };

var $data = {
    fromByteArray: function (bytes) { return new StubData(bytes); },
    fromData: function (data) { return new StubData(data._bytes); },
    fromHex: function (hex) {
        var out = [];
        for (var i = 0; i + 1 < hex.length; i += 2) {
            out.push(parseInt(hex.slice(i, i + 2), 16));
        }
        return new StubData(out);
    },
    fromUTF8: function (str) { return new StubData(utf8Bytes(str)); },
    fromBase64: function (b64) {
        var out = [];
        var clean = b64.replace(/=+$/, "");
        for (var i = 0; i < clean.length; i += 4) {
            var n = 0, got = 0;
            for (var j = 0; j < 4; j++) {
                n <<= 6;
                if (i + j < clean.length) { n |= B64.indexOf(clean.charAt(i + j)); got++; }
            }
            out.push((n >> 16) & 255);
            if (got > 2) { out.push((n >> 8) & 255); }
            if (got > 3) { out.push(n & 255); }
        }
        return new StubData(out);
    },
    isData: function (obj) { return obj instanceof StubData; }
};

var logs = [];
var $log = {
    info: function (m) { logs.push(String(m)); },
    error: function (m) { logs.push("E " + String(m)); }
};
var $env = { appVersion: "0.0.0", appBuild: "0", macOSVersion: "stub" };

var timers = [];
var $timer = {
    schedule: function (o) { timers.push(o); return timers.length; },
    invalidate: function (id) { timers[id - 1] = null; }
};

// 依次触发所有还没取消的一次性定时器（含触发过程中新建的），上限防止死循环
function flushTimers(skipLongerThan) {
    for (var i = 0; i < timers.length && i < 200; i++) {
        var t = timers[i];
        if (t && t.interval <= skipLongerThan) {
            timers[i] = null;
            t.handler();
        }
    }
}

var httpRequests = [];
var $http = {
    request: function (o) { httpRequests.push(o); }
};

var lastSocket = null;
var sockets = [];
var $websocket = {
    new: function (params) {
        lastSocket = {
            params: params,
            readyState: 0,
            sent: [],
            closed: 0,
            on: {},
            open: function () { this.opened = true; },
            closeArgs: [],
            close: function (arg) {
                this.closeArgs.push(arguments.length ? JSON.stringify(arg) : "noarg");
                if (arg === undefined) {
                    throw new TypeError("undefined is not an object (evaluating 'socket.close()')");
                }
                this.closed++;
                this.readyState = 3;
            },
            sendString: function (s) { this.sent.push(s); },
            listenOpen: function (f) { this.on.open = f; },
            listenClose: function (f) { this.on.close = f; },
            listenError: function (f) { this.on.error = f; },
            listenReceiveString: function (f) { this.on.string = f; },
            listenReceiveData: function (f) { this.on.data = f; }
        };
        sockets.push(lastSocket);
        return lastSocket;
    }
};

var exports = {};
load("poc/main.js");

// ---------------------------------------------------------------- 签名

eq(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256(abc)");
eq(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA256(空串)");
eq(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", "SHA256(跨两个分组)");
eq(sha256Hex("你好，世界"), "46932f1e6ea5216e77f58b1908d72ec9322ed129318c6d4bd4450b5eaab9d7e7", "SHA256(UTF-8 中文)");
eq(gecPlaintext(1700000000), "1334447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4", "待哈希字串 1700000000");
eq(secMsGec(1700000000), "42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF", "GEC 1700000000");
eq(gecPlaintext(1760000000.789), "1340447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4", "待哈希字串 1760000000.789");
eq(secMsGec(1760000000.789), "70AED27457006C255086B4F079B9FE44A4D10827C4AFDFC3C45583B6F40D7DDF", "GEC 1760000000.789");
ok(!/e\+/i.test(gecPlaintext(4102444800)), "ticks 不出现科学计数法");
eq(selfTest().length, 0, "selfTest 无失败项");

// ---------------------------------------------------------------- 报文

eq(dateString(new Date(Date.UTC(2026, 8, 25, 10, 0, 0))),
    "Fri Sep 25 2026 10:00:00 GMT+0000 (Coordinated Universal Time)", "日期字串");
eq(dateString(new Date(Date.UTC(2026, 0, 5, 3, 4, 9))),
    "Mon Jan 05 2026 03:04:09 GMT+0000 (Coordinated Universal Time)", "日期字串补零");
eq(escapeXml("a<b>&c\u0001d"), "a&lt;b&gt;&amp;c d", "XML 转义与控制字符");
ok(/^[0-9a-f]{32}$/.test(randomHex(32, false)), "randomHex 小写");
ok(/^[0-9A-F]{32}$/.test(randomHex(32, true)), "randomHex 大写");

var fixed = new Date(Date.UTC(2026, 8, 25, 10, 0, 0));
var cfg = buildSpeechConfig(fixed);
ok(cfg.indexOf("X-Timestamp:Fri Sep 25 2026 10:00:00 GMT+0000 (Coordinated Universal Time)\r\n" +
    "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{") === 0, "speech.config 头");
ok(/\}\r\n$/.test(cfg), "speech.config 以 CRLF 结尾");
eq(JSON.parse(cfg.split("\r\n\r\n")[1]).context.synthesis.audio.outputFormat,
    "audio-24khz-48kbitrate-mono-mp3", "speech.config JSON 可解析");
var ssml = buildSsml(fixed, "zh-CN-XiaoxiaoNeural", "你好，<世界>");
ok(/^X-RequestId:[0-9a-f]{32}\r\nContent-Type:application\/ssml\+xml\r\nX-Timestamp:.*\)Z\r\nPath:ssml\r\n\r\n<speak /.test(ssml),
    "ssml 头与多出来的 Z");
ok(ssml.indexOf("<voice name='zh-CN-XiaoxiaoNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
    "你好，&lt;世界&gt;</prosody></voice></speak>") > 0, "ssml 正文");
ok(/^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=[0-9a-f]{32}&Sec-MS-GEC=[0-9A-F]{64}&Sec-MS-GEC-Version=1-143\.0\.3650\.75$/
    .test(buildUrl(WSS_URL, fixed)), "URL 形状");
ok(/^muid=[0-9A-F]{32};$/.test(buildHeader().Cookie), "Cookie 形状");

// ---------------------------------------------------------------- 状态机

function binaryFrame(headerText, audioBytes) {
    var head = asciiBytes(headerText);
    return new StubData([head.length >> 8, head.length & 255].concat(head).concat(audioBytes));
}

function textFrame(path) {
    return "X-RequestId:0123456789abcdef0123456789abcdef\r\n" +
        "Content-Type:application/json; charset=utf-8\r\nPath:" + path + "\r\n\r\n{}";
}

var AUDIO_HEAD = "X-RequestId:0123456789abcdef0123456789abcdef\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n";
var EMPTY_HEAD = "X-RequestId:0123456789abcdef0123456789abcdef\r\nPath:audio\r\n";

function chunk(start, count) {
    var out = [];
    for (var i = 0; i < count; i++) {
        out.push((start + i * 7) & 255);
    }
    return out;
}

function reset() {
    logs = [];
    timers = [];
    sockets = [];
    httpRequests = [];
}

function runTts(label, text, lang, script) {
    reset();
    var results = [];
    tts({ text: text, lang: lang }, function (r) { results.push(r); });
    script(results);
    return results;
}

function play(s, audioChunks) {
    s.readyState = 1;
    s.on.open(s);
    s.on.string(s, textFrame("turn.start"));
    s.on.string(s, textFrame("response"));
    for (var i = 0; i < audioChunks.length; i++) {
        s.on.data(s, binaryFrame(AUDIO_HEAD, audioChunks[i]));
        if (i === 0) {
            s.on.string(s, textFrame("audio.metadata"));
        }
    }
    s.on.data(s, binaryFrame(EMPTY_HEAD, []));
    s.on.string(s, textFrame("turn.end"));
}

function summaryOf(label) {
    return logs.filter(function (l) { return l.indexOf(label + " SUMMARY") >= 0; })[0] || "";
}

[[true, false], [false, false], [false, true]].forEach(function (flavor) {
    var withLength = flavor[0];
    exposeLength = withLength;
    subDataRejectsEnd = flavor[1];
    var label = (withLength ? "$data 有 length" : "$data 无 length") + (flavor[1] ? " + subData 怪癖" : "");
    var a1 = chunk(1, 720), a2 = chunk(9, 1440), a3 = chunk(33, 300);

    var results = runTts(label, "你好，世界", "zh-Hans", function (results) {
        var s = lastSocket;
        eq(sockets.length, 1, label + "：正常模式只开一条连接");
        ok(s.opened === true, label + "：调用了 open()");
        ok(/Edg\/143\.0\.0\.0$/.test(s.params.header["User-Agent"]), label + "：UA 像 Edge");
        eq(s.params.headers, undefined, label + "：正常模式不传 headers");
        eq(s.params.timeoutInterval, 30, label + "：timeoutInterval");
        ok(s.params.url.indexOf(WSS_URL + "?TrustedClientToken=") === 0, label + "：连的是 Edge 接口");
        play(s, [a1, a2, a3]);
        eq(s.sent.length, 2, label + "：发出两条文本帧");
        ok(s.sent[0].indexOf("Path:speech.config") > 0 && s.sent[1].indexOf("Path:ssml") > 0, label + "：发送顺序");
        ok(s.sent[1].indexOf("<voice name='zh-CN-XiaoxiaoNeural'>") > 0, label + "：中文音色");
        eq(results.length, 1, label + "：turn.end 后立即交付，不等定时器");
        ok(s.closed >= 1, label + "：turn.end 后关闭连接");
        eq(s.closeArgs.join("|"), "{}", label + "：正常模式用 close({})");
        ok(logs.some(function (l) { return l.indexOf('"audioVia":"' + (flavor[1] ? "fromByteArray" : "subData") + '"') > 0; }),
            label + "：取音频的途径");
        s.on.close(s, 1000, "");
        s.on.string(s, textFrame("turn.end"));
        s.on.error(s, { code: 1, type: "x", message: "late" });
        flushTimers(1000);
    });
    eq(results.length, 1, label + "：completion 只触发一次");
    var r = results[0];
    ok(r.result && r.result.type === "base64", label + "：返回 base64");
    eq(r.result && r.result.value, base64Of(a1.concat(a2).concat(a3)), label + "：音频拼接正确");
    var summary = summaryOf("edge");
    ok(summary.indexOf('"audioBytes":2460') > 0 && summary.indexOf('"audioFrames":3') > 0 &&
        summary.indexOf('"emptyAudioFrames":1') > 0 && summary.indexOf('"malformedFrames":0') > 0,
        label + "：SUMMARY 计数 " + summary);
    ok(logs.some(function (l) { return l.indexOf('"typeofLength":"' + (withLength ? "number" : "undefined") + '"') > 0; }),
        label + "：日志里有 typeof data.length");
    ok(logs.some(function (l) { return l.indexOf("CLOSE (结束之后)") > 0; }), label + "：结束之后的事件照样记日志");
    ok(!logs.some(function (l) { return l.indexOf("你好") >= 0; }), label + "：日志不含朗读原文");
});

exposeLength = false;
subDataRejectsEnd = true;

var en = runTts("英文", "Hello, world.", "en", function () {
    play(lastSocket, [chunk(1, 10)]);
});
ok(lastSocket.sent[1].indexOf("<voice name='en-US-AriaNeural'>") > 0 && en[0].result, "英文：音色换成 Aria");

var errRun = runTts("握手出错", "你好", "zh-Hans", function () {
    lastSocket.on.error(lastSocket, { code: 403, type: "handshake", message: "bad response code 403" });
    lastSocket.on.close(lastSocket, 1006, "x");
    flushTimers(1000);
});
eq(errRun.length, 1, "握手出错：completion 只触发一次");
ok(errRun[0].error && errRun[0].error.type === "api", "握手出错：error.type=api");
ok(errRun[0].error.addition.code === 403 && errRun[0].error.addtion.code === 403, "握手出错：addition 两种拼写都填");
ok(logs.some(function (l) { return l.indexOf("ERROR") >= 0 && l.indexOf('"code":403') >= 0; }), "握手出错：error 对象 JSON 进日志");

var noAudio = runTts("无音频", "你好", "zh-Hans", function () {
    lastSocket.on.open(lastSocket);
    lastSocket.on.string(lastSocket, textFrame("turn.start"));
    lastSocket.on.string(lastSocket, textFrame("turn.end"));
});
ok(noAudio.length === 1 && noAudio[0].error && noAudio[0].error.type === "api", "无音频：返回错误");

var timeoutRun = runTts("超时", "你好", "zh-Hans", function () {
    lastSocket.on.open(lastSocket);
    flushTimers(1000);
    lastSocket.on.string(lastSocket, textFrame("turn.end"));
});
ok(timeoutRun.length === 1 && timeoutRun[0].error.type === "network", "超时：error.type=network");

var earlyClose = runTts("提前关闭", "你好", "zh-Hans", function () {
    lastSocket.on.open(lastSocket);
    lastSocket.on.close(lastSocket, 1006, "gone");
});
ok(earlyClose.length === 1 && earlyClose[0].error, "提前关闭：返回错误");

var malformed = runTts("残帧", "你好", "zh-Hans", function () {
    lastSocket.on.open(lastSocket);
    lastSocket.on.data(lastSocket, new StubData([0x40, 0x00, 1, 2, 3]));
    lastSocket.on.data(lastSocket, binaryFrame(AUDIO_HEAD, chunk(5, 10)));
    lastSocket.on.string(lastSocket, textFrame("turn.end"));
});
ok(malformed[0].result && summaryOf("edge").indexOf('"malformedFrames":1') > 0,
    "残帧：计入 malformedFrames 且不影响其余音频");

// 探针模式：文本是本机 ws 地址时连两次，第一次带完整握手头和 headers 标记，第二次什么头都不带
var probeAudio = chunk(3, 50);
var probe = runTts("探针", "探针 ws://127.0.0.1:18765/probe ", "zh-Hans", function (results) {
    var first = sockets[0];
    ok(first.params.url.indexOf("ws://127.0.0.1:18765/probe?TrustedClientToken=") === 0, "探针：改连本机地址");
    eq(first.params.header["X-Poc-Param"], "header", "探针：header 带标记");
    eq(first.params.headers["X-Poc-Param"], "headers", "探针：headers 带标记");
    ok(/Edg\/143/.test(first.params.header["User-Agent"]), "探针：握手头与正常模式一致");
    play(first, [probeAudio]);
    eq(first.closeArgs.length, 0, "探针：结束后先不 close，等着看自然事件");
    eq(results.length, 0, "探针：第一次连接结束后还不交付");
    flushTimers(10);
    eq(first.closeArgs.join("|"), "noarg", "探针：第一条用 close()");
    ok(logs.some(function (l) { return l.indexOf("CALLED close (结束之后) form=noarg ret=THROWN:TypeError") > 0; }),
        "探针：close() 抛的异常被接住并记日志");
    eq(sockets.length, 2, "探针：接着开第二条连接");
    var second = sockets[1];
    ok(second.params.url.indexOf("ws://127.0.0.1:18765/bare?TrustedClientToken=") === 0, "探针：第二条连 /bare");
    eq(second.params.header, undefined, "探针：第二条不传 header");
    eq(second.params.headers, undefined, "探针：第二条不传 headers");
    second.on.error(second, { code: 61, message: "refused" });
    flushTimers(10);
    eq(second.closeArgs.join("|"), "{}", "探针：第二条用 close({})");
    eq(sockets.length, 3, "探针：接着开第三条连接");
    var third = sockets[2];
    ok(third.params.url.indexOf("ws://127.0.0.1:18765/plural?TrustedClientToken=") === 0, "探针：第三条连 /plural");
    eq(third.params.header, undefined, "探针：第三条不传 header");
    ok(/Edg\/143/.test(third.params.headers["User-Agent"]), "探针：第三条握手头只放在 headers 里");
    eq(results.length, 0, "探针：第三条结束前不交付");
    play(third, [chunk(9, 20)]);
    flushTimers(10);
    eq(third.closeArgs.join("|"), '{"code":1000}', "探针：第三条用 close({code: 1000})");
});
eq(probe.length, 1, "探针：completion 只触发一次");
eq(probe[0].result && probe[0].result.value, base64Of(probeAudio), "探针：交付第一条连接的音频");

runTts("探针无路径", "ws://localhost:18765", "en", function () {
    ok(sockets[0].params.url.indexOf("ws://localhost:18765?TrustedClientToken=") === 0, "探针无路径：地址原样");
    sockets[0].on.error(sockets[0], {});
    flushTimers(10);
    ok(sockets[1].params.url.indexOf("ws://localhost:18765/bare?") === 0, "探针无路径：第二条地址");
    sockets[1].on.error(sockets[1], {});
    flushTimers(10);
    sockets[2].on.error(sockets[2], {});
    flushTimers(10);
});

runTts("网址在句中", "连 ws://127.0.0.1:18765/probe 试试", "zh-Hans", function () {
    eq(sockets.length, 1, "网址在句中：不触发探针");
    ok(lastSocket.params.url.indexOf(WSS_URL) === 0, "网址在句中：照常连 Edge");
});

runTts("非本机地址", "ws://example.com:80/x", "en", function () {
    eq(sockets.length, 1, "非本机地址：不触发探针");
    ok(lastSocket.params.url.indexOf(WSS_URL) === 0, "非本机地址：照常连 Edge");
});

// 诊断模式：$http → 签错时间 → 不带头 → 连接被拒 → 域名不存在 → 正常合成
var diagAudio = chunk(7, 40);
var diag = runTts("诊断", "诊断 poc-diag", "zh-Hans", function (results) {
    ok(logs.some(function (l) { return l.indexOf("data10 subData(2,9)=7字节:02030405060708") > 0; }), "诊断：$data 语义进日志");
    ok(logs.some(function (l) { return l.indexOf("data10 subData(2,10)=非$data:undefined") > 0; }), "诊断：subData 怪癖被如实记录");
    ok(logs.some(function (l) { return l.indexOf("data200k ms ") > 0 && l.indexOf("toByteArray=") > 0; }), "诊断：大块数据耗时");
    eq(httpRequests.length, 1, "诊断：接着发 $http 请求");
    eq(httpRequests[0].method, "GET", "诊断：GET");
    ok(httpRequests[0].url.indexOf("/voices/list?trustedclienttoken=") > 0, "诊断：音色列表地址");
    eq(sockets.length, 0, "诊断：$http 回来之前不开连接");
    httpRequests[0].handler({
        data: [{ ShortName: "zh-CN-XiaoxiaoNeural" }, { ShortName: "en-US-AriaNeural" }, { ShortName: "x" }],
        response: { statusCode: 200, headers: { Date: "Sun, 27 Sep 2026 03:18:56 GMT" } }
    });
    ok(logs.some(function (l) { return l.indexOf('headers.Date="Sun, 27 Sep 2026 03:18:56 GMT"') > 0; }), "诊断：Date 头进日志");
    ok(logs.some(function (l) { return l.indexOf("voices found=zh-CN-XiaoxiaoNeural,en-US-AriaNeural") > 0; }), "诊断：音色核对");

    var expectUrls = [WSS_URL, WSS_URL, "ws://127.0.0.1:1/refused", "wss://edge-tts-poc.invalid/nxdomain"];
    for (var i = 0; i < 4; i++) {
        eq(sockets.length, i + 1, "诊断：第 " + (i + 1) + " 条连接");
        ok(sockets[i].params.url.indexOf(expectUrls[i]) === 0, "诊断：第 " + (i + 1) + " 条地址");
        sockets[i].on.error(sockets[i], { code: 403 });
        flushTimers(7);
    }
    ok(sockets[0].params.url !== sockets[1].params.url, "诊断：两次握手 ConnectionId 不同");
    ok(sockets[0].params.header && !sockets[1].params.header, "诊断：第二条不带握手头");
    var gecNow = secMsGec(Date.now() / 1000);
    ok(sockets[0].params.url.indexOf("Sec-MS-GEC=" + gecNow) < 0, "诊断：第一条用偏 900 秒的签名");
    ok(sockets[1].params.url.indexOf("Sec-MS-GEC=" + gecNow) > 0, "诊断：第二条签名正常");
    eq(results.length, 0, "诊断：前面几步失败不交付");
    eq(sockets.length, 5, "诊断：最后开正常合成的连接");
    play(sockets[4], [diagAudio]);
    ok(sockets[4].sent[1].indexOf(">诊断完成</prosody>") > 0, "诊断：合成固定文本");
    flushTimers(7);
});
eq(diag.length, 1, "诊断：completion 只触发一次");
eq(sockets[2].params.timeoutInterval, 3, "诊断：连不上的场景 timeoutInterval=3");
eq(sockets[0].params.timeoutInterval, 30, "诊断：其余场景 timeoutInterval=30");

// 诊断二：四种本机故障场景，最后正常合成
var diag2 = runTts("诊断二", "诊断 poc-diag2 ws://127.0.0.1:18765", "zh-Hans", function (results) {
    ok(logs.some(function (l) { return l.indexOf("data toHex()=abcdef0a toHex(true)=ABCDEF0A") > 0; }), "诊断二：toHex 大小写");
    var paths = ["/reject403", "/close-frame", "/drop", "/hang"];
    for (var i = 0; i < paths.length; i++) {
        eq(sockets.length, i + 1, "诊断二：第 " + (i + 1) + " 条连接");
        ok(sockets[i].params.url.indexOf("ws://127.0.0.1:18765" + paths[i] + "?TrustedClientToken=") === 0,
            "诊断二：第 " + (i + 1) + " 条地址");
        if (i === 3) {
            eq(sockets[i].params.timeoutInterval, 3, "诊断二：hang 场景 timeoutInterval=3");
            flushTimers(10);
        } else {
            sockets[i].on.close(sockets[i], 1011, "server going away");
            flushTimers(7);
        }
    }
    ok(logs.some(function (l) { return l.indexOf("diag2-hang") > 0 && l.indexOf("TIMER") > 0; }), "诊断二：hang 靠插件自己的定时器收场");
    eq(results.length, 0, "诊断二：故障场景不交付");
    eq(sockets.length, 5, "诊断二：最后开正常合成的连接");
    ok(sockets[4].params.url.indexOf(WSS_URL) === 0, "诊断二：最后连 Edge");
    play(sockets[4], [chunk(2, 30)]);
});
ok(diag2.length === 1 && diag2[0].result, "诊断二：交付最后一步的音频");
eq(diag[0].result && diag[0].result.value, base64Of(diagAudio), "诊断：交付最后一步的音频");

ok(supportLanguages().indexOf("zh-Hans") >= 0 && supportLanguages().indexOf("en") >= 0 &&
    supportLanguages().indexOf("de") >= 0, "supportLanguages 含中英文，也含会被误判的语种");
eq(pluginTimeoutInterval(), 60, "pluginTimeoutInterval");
eq(typeof exports.tts, "function", "exports.tts");

if (failures.length === 0) {
    print("ALL PASS (" + checks + " checks)");
} else {
    print("FAILED " + failures.length + "/" + checks);
    // jsc 的 quit() 不带退出码，靠未捕获异常让进程以非零状态结束
    throw new Error("FAILED " + failures.length + "/" + checks);
}
