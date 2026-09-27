// 联网冒烟测试用的宿主：用系统的 JavaScriptCore 加载插件的 config.js / main.js，
// 把 $websocket / $http / $timer / $log / $data 接到真实网络上，模拟 Bob 的插件运行时。
//
// 它验证的是插件自己的协议实现（签名、消息、帧解析、分段拼接、时钟兜底），
// 不能代替 Bob 真机测试：这里的 $websocket 是 URLSessionWebSocketTask，不是 Bob 用的 Starscream。
//
// 用法：harness <src 目录> [--text 文本 | --text-file 文件] [--lang zh-Hans]
//              [--option 键=值]... [--clock-offset 秒] [--validate] [--out 输出.mp3]

import Foundation
import JavaScriptCore

var arguments = Array(CommandLine.arguments.dropFirst())
guard !arguments.isEmpty else {
    print("usage: harness <src dir> [--text T] [--text-file F] [--lang L] [--option k=v] [--clock-offset S] [--validate] [--out F]")
    exit(2)
}
let sourceDir = URL(fileURLWithPath: arguments.removeFirst())
var text = "你好，世界"
var lang = "zh-Hans"
var options: [String: String] = [:]
var clockOffsetSeconds = 0.0
var validate = false
var outPath: String? = nil

while !arguments.isEmpty {
    let flag = arguments.removeFirst()
    switch flag {
    case "--text": text = arguments.removeFirst()
    case "--text-file": text = try! String(contentsOfFile: arguments.removeFirst(), encoding: .utf8)
    case "--lang": lang = arguments.removeFirst()
    case "--option":
        let pair = arguments.removeFirst()
        if let index = pair.firstIndex(of: "=") {
            options[String(pair[..<index])] = String(pair[pair.index(after: index)...])
        }
    case "--clock-offset": clockOffsetSeconds = Double(arguments.removeFirst()) ?? 0
    case "--validate": validate = true
    case "--out": outPath = arguments.removeFirst()
    default:
        print("unknown flag \(flag)")
        exit(2)
    }
}

let context = JSContext()!
context.exceptionHandler = { _, exception in
    print("JS EXCEPTION: \(exception?.toString() ?? "?")")
}

func jsonString(_ value: Any) -> String {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    return String(data: data, encoding: .utf8)!
}

func call(_ name: String, _ args: [Any]) {
    context.objectForKeyedSubscript(name)!.call(withArguments: args)
}

let started = Date()
func stamp() -> String {
    String(format: "%6.2fs", Date().timeIntervalSince(started))
}

// ---------------------------------------------------------------- $log

let logBlock: @convention(block) (String, String) -> Void = { level, message in
    print("[\(stamp())] \(level) \(message)")
}
context.setObject(logBlock, forKeyedSubscript: "__log" as NSString)

// ---------------------------------------------------------------- $timer

var timers: [Int: Timer] = [:]
let timerStart: @convention(block) (Int, Double, Bool) -> Void = { id, interval, repeats in
    let timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: repeats) { _ in
        if !repeats {
            timers[id] = nil
        }
        call("__timerEvent", [id])
    }
    timers[id] = timer
}
let timerStop: @convention(block) (Int) -> Void = { id in
    timers[id]?.invalidate()
    timers[id] = nil
}
context.setObject(timerStart, forKeyedSubscript: "__timerStart" as NSString)
context.setObject(timerStop, forKeyedSubscript: "__timerStop" as NSString)

// ---------------------------------------------------------------- $http

let httpConfiguration = URLSessionConfiguration.ephemeral
httpConfiguration.httpCookieStorage = nil
httpConfiguration.httpShouldSetCookies = false
let httpSession = URLSession(configuration: httpConfiguration, delegate: nil, delegateQueue: OperationQueue.main)

let httpRequest: @convention(block) (Int, String, String, String, Double) -> Void = { id, method, url, headersJSON, timeout in
    var request = URLRequest(url: URL(string: url)!)
    request.httpMethod = method
    request.timeoutInterval = timeout
    if let data = headersJSON.data(using: .utf8),
       let headers = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
    }
    httpSession.dataTask(with: request) { data, response, error in
        if let error = error {
            call("__httpEvent", [id, 0, "{}", 0, error.localizedDescription])
            return
        }
        let http = response as! HTTPURLResponse
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            headers["\(key)"] = "\(value)"
        }
        call("__httpEvent", [id, http.statusCode, jsonString(headers), data?.count ?? 0, ""])
    }.resume()
}
context.setObject(httpRequest, forKeyedSubscript: "__httpRequest" as NSString)

// ---------------------------------------------------------------- $websocket

final class SocketDelegate: NSObject, URLSessionWebSocketDelegate {
    let id: Int
    var opened = false
    var finished = false

    init(id: Int) {
        self.id = id
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        opened = true
        call("__wsEvent", [id, "open"])
        receive(webSocketTask)
    }

    func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self, !self.finished else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let string):
                    call("__wsEvent", [self.id, "text", string])
                case .data(let data):
                    call("__wsEvent", [self.id, "data", data.base64EncodedString()])
                @unknown default:
                    break
                }
                self.receive(task)
            case .failure:
                // 由 didCompleteWithError / didCloseWith 上报
                break
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard !finished else { return }
        finished = true
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        call("__wsEvent", [id, "close", closeCode.rawValue, text])
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        finished = true
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if let error = error {
            let nsError = error as NSError
            let payload: [String: Any] = [
                "code": status != 0 ? status : nsError.code,
                "message": nsError.localizedDescription,
                "type": opened ? "stream" : "upgradeError",
                "httpStatus": status,
                "nsCode": nsError.code
            ]
            call("__wsEvent", [id, "error", payload])
        } else {
            call("__wsEvent", [id, "close", 1006, ""])
        }
    }
}

var socketTasks: [Int: URLSessionWebSocketTask] = [:]
var socketDelegates: [Int: SocketDelegate] = [:]
var socketSessions: [Int: URLSession] = [:]
var nextSocketId = 0

let wsCreate: @convention(block) (String, String, Double) -> Int = { url, headersJSON, timeout in
    nextSocketId += 1
    let id = nextSocketId
    var request = URLRequest(url: URL(string: url)!)
    request.timeoutInterval = timeout
    if let data = headersJSON.data(using: .utf8),
       let headers = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    let delegate = SocketDelegate(id: id)
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: OperationQueue.main)
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = 16 * 1024 * 1024
    socketTasks[id] = task
    socketDelegates[id] = delegate
    socketSessions[id] = session
    return id
}
let wsOpen: @convention(block) (Int) -> Void = { id in
    socketTasks[id]?.resume()
}
let wsSend: @convention(block) (Int, String) -> Void = { id, message in
    socketTasks[id]?.send(.string(message)) { error in
        if let error = error {
            print("[\(stamp())] ws send failed: \(error.localizedDescription)")
        }
    }
}
let wsClose: @convention(block) (Int) -> Void = { id in
    socketDelegates[id]?.finished = true
    socketTasks[id]?.cancel(with: .normalClosure, reason: nil)
    socketSessions[id]?.invalidateAndCancel()
    socketTasks[id] = nil
}
context.setObject(wsCreate, forKeyedSubscript: "__wsCreate" as NSString)
context.setObject(wsOpen, forKeyedSubscript: "__wsOpen" as NSString)
context.setObject(wsSend, forKeyedSubscript: "__wsSend" as NSString)
context.setObject(wsClose, forKeyedSubscript: "__wsClose" as NSString)

// ---------------------------------------------------------------- 结果

var finished = false
var exitCode: Int32 = 1
var completionCalls = 0

let onCompletion: @convention(block) (String, String) -> Void = { json, audioBase64 in
    completionCalls += 1
    print("[\(stamp())] completion #\(completionCalls): \(json)")
    if !audioBase64.isEmpty, let data = Data(base64Encoded: audioBase64) {
        print("[\(stamp())] audio bytes=\(data.count) head=\(data.prefix(4).map { String(format: "%02x", $0) }.joined())")
        if let outPath = outPath {
            try! data.write(to: URL(fileURLWithPath: outPath))
            print("[\(stamp())] wrote \(outPath)")
        }
        exitCode = 0
    } else if json.contains("\"result\":true") {
        exitCode = 0
    }
    // 再等一小会儿，看有没有重复回调
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        finished = true
    }
}
context.setObject(onCompletion, forKeyedSubscript: "__completion" as NSString)

// ---------------------------------------------------------------- JS 侧的胶水

let glue = """
var globalThis = this;
(function () {
    var realNow = Date.now;
    var offset = \(Int(clockOffsetSeconds * 1000));
    Date.now = function () { return realNow.call(Date) + offset; };
})();

var $log = {
    info: function (m) { __log("INFO ", String(m)); },
    error: function (m) { __log("ERROR", String(m)); }
};
var $option = \(jsonString(options));
var $env = { appVersion: "harness", appBuild: "0" };

var __B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function __decode(base64) {
    var bytes = [], acc = 0, bits = 0;
    for (var i = 0; i < base64.length; i++) {
        var v = __B64.indexOf(base64.charAt(i));
        if (v < 0) continue;
        acc = (acc << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255); acc &= (1 << bits) - 1; }
    }
    return bytes;
}
// 与真机一致：没有 length 属性
function __makeData(base64) {
    var bytes = null;
    return {
        __data: true,
        toByteArray: function () { if (!bytes) bytes = __decode(base64); return bytes.slice(); },
        toBase64: function () { return base64; }
    };
}
var $data = { isData: function (v) { return !!(v && v.__data); } };

var __timers = {}, __timerSeq = 0;
var $timer = {
    schedule: function (o) { var id = ++__timerSeq; __timers[id] = o.handler; __timerStart(id, o.interval, !!o.repeats); return id; },
    invalidate: function (id) { delete __timers[id]; __timerStop(id); }
};
function __timerEvent(id) { var h = __timers[id]; if (h) h(); }

var __https = {}, __httpSeq = 0;
var $http = {
    request: function (o) {
        var id = ++__httpSeq; __https[id] = o.handler;
        __httpRequest(id, o.method || "GET", o.url, JSON.stringify(o.header || {}), o.timeout || 30);
    }
};
function __httpEvent(id, status, headersJSON, size, error) {
    var h = __https[id]; delete __https[id];
    if (!h) return;
    if (error) { h({ error: { message: error }, response: null }); return; }
    h({ response: { statusCode: status, headers: JSON.parse(headersJSON) }, data: { size: size } });
}

var __sockets = {};
var $websocket = {
    new: function (params) {
        var id = __wsCreate(params.url, JSON.stringify(params.header || {}), params.timeoutInterval || 60);
        var socket = {
            handlers: {}, readyState: 0,
            listenOpen: function (f) { this.handlers.open = f; },
            listenClose: function (f) { this.handlers.close = f; },
            listenError: function (f) { this.handlers.error = f; },
            listenReceiveString: function (f) { this.handlers.text = f; },
            listenReceiveData: function (f) { this.handlers.data = f; },
            open: function () { __wsOpen(id); },
            close: function () { this.readyState = 3; __wsClose(id); },
            sendString: function (s) { __wsSend(id, s); }
        };
        __sockets[id] = socket;
        return socket;
    }
};
function __wsEvent(id, kind, a, b) {
    var socket = __sockets[id];
    if (!socket || !socket.handlers[kind]) return;
    if (kind === "open") { socket.readyState = 1; socket.handlers.open(socket); }
    else if (kind === "text") socket.handlers.text(socket, a);
    else if (kind === "data") socket.handlers.data(socket, __makeData(a));
    else if (kind === "error") socket.handlers.error(socket, a);
    else if (kind === "close") { socket.readyState = 3; socket.handlers.close(socket, a, b); }
}

var __modules = {};
function __load(name, source) {
    var module = { exports: {} };
    var fn = new Function("module", "exports", "require", source);
    fn(module, module.exports, function (path) {
        var key = path.replace(/^\\.\\//, "");
        if (!__modules[key]) throw new Error("未知模块: " + path);
        return __modules[key];
    });
    __modules[name] = module.exports;
    return module.exports;
}
function __report(value) {
    var audio = "";
    var copy = {};
    Object.keys(value || {}).forEach(function (k) { copy[k] = value[k]; });
    if (copy.result && typeof copy.result === "object" && copy.result.value) {
        audio = copy.result.value;
        copy.result = { type: copy.result.type, value: "<" + audio.length + " base64 chars>", raw: copy.result.raw };
    }
    __completion(JSON.stringify(copy), audio);
}
"""
context.evaluateScript(glue)

for name in ["config.js", "main.js"] {
    let source = try! String(contentsOf: sourceDir.appendingPathComponent(name), encoding: .utf8)
    call("__load", [name, source])
}

print("[\(stamp())] start lang=\(lang) chars=\(text.count) utf8=\(text.utf8.count) options=\(options) clockOffset=\(clockOffsetSeconds)s validate=\(validate)")

let plugin = context.objectForKeyedSubscript("__modules")!.objectForKeyedSubscript("main.js")!
let report = context.objectForKeyedSubscript("__report")!
if validate {
    plugin.invokeMethod("pluginValidate", withArguments: [report])
} else {
    plugin.invokeMethod("tts", withArguments: [["text": text, "lang": lang], report])
}

let deadline = Date().addingTimeInterval(75)
while !finished && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
}
if !finished {
    print("[\(stamp())] 宿主等待超时：completion 一直没有被调用")
    exitCode = 3
}
if completionCalls > 1 {
    print("[\(stamp())] completion 被调用了 \(completionCalls) 次")
    exitCode = 4
}
exit(exitCode)
