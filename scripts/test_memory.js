#!/usr/bin/env node
// 从 $data / tts 边界检查音频数组的生命周期。需要 node --expose-gc。
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

if (typeof global.gc !== "function") {
    throw new Error("请用 node --expose-gc scripts/test_memory.js 运行");
}
globalThis.print = function (value) { console.log(value); };
globalThis.load = function (file) {
    vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
};

const suite = fs.readFileSync("scripts/test_plugin.js", "utf8");
const boundary = suite.indexOf("// ------------------------------------------------------------ 用例\n");
assert(boundary > 0, "找不到插件测试的运行时桩");
vm.runInThisContext(suite.slice(0, boundary), { filename: "plugin-runtime" });
vm.runInThisContext(`
    reset();
    var observedArrays = [];
    var originalMakeData = makeData;
    makeData = function (bytes, shape) {
        var data = originalMakeData(bytes, shape);
        if (data.toByteArray) {
            var original = data.toByteArray;
            data.toByteArray = function () {
                var array = original();
                observedArrays.push(new WeakRef(array));
                return array;
            };
        }
        return data;
    };
    for (var i = 0; i < 5; i++) {
        socketScripts.push(successScript(fakeAudio(100000), 100000));
    }
    socketScripts.push(openOnlyScript);
    var memoryCalls = speak({ text: repeat("a", 13000), lang: "en" });
    // 模拟原生宿主释放已关闭连接和已结束定时器，排除桩自身的强引用。
    function releaseClosedMocks() {
        sockets.forEach(function (socket) {
            if (socket.closeCalls) { socket.handlers = {}; socket.script = null; }
        });
        timers.forEach(function (timer) {
            if (!timer.active) { timer.handler = null; }
        });
    }
    releaseClosedMocks();
`, { filename: "memory-scenario" });

setImmediate(function () {
    global.gc();
    const retained = observedArrays.filter(function (ref) { return ref.deref(); }).length;
    assert.strictEqual(memoryCalls.length, 0, "最后一段仍在等待，不应完成朗读");
    assert.strictEqual(retained, 0, "已拼接的音频数组应在整次朗读结束前释放");
    sockets[sockets.length - 1].fireClose(1007, "Unsupported voice test");
    releaseClosedMocks();
    setImmediate(function () {
        global.gc();
        assert.strictEqual(memoryCalls.length, 1, "任务失败只能回调一次");
        assert.strictEqual(observedArrays.filter(function (ref) { return ref.deref(); }).length, 0);
        console.log("memory ok   已拼接的音频数组在任务进行中即可回收");
    });
});
