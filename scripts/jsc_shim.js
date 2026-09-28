#!/usr/bin/env node
// 没有 macOS 时用 Node 代替 jsc 跑测试：补上 jsc 的 print / load / checkSyntax 三个全局函数。
// Bob 跑插件用的是 JavaScriptCore，结论以 jsc 为准；这里只是让 Linux 上也能跑同一套用例。
// Makefile 在找不到 jsc 时自动改用它，也可以手动：
//     node scripts/jsc_shim.js scripts/test_plugin.js
//     node scripts/jsc_shim.js -e 'checkSyntax("src/main.js")'
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function source(file) {
    var full = path.resolve(process.cwd(), file);
    return { code: fs.readFileSync(full, "utf8"), filename: full };
}

globalThis.print = function () {
    console.log(Array.prototype.join.call(arguments, " "));
};

globalThis.load = function (file) {
    var loaded = source(file);
    vm.runInThisContext(loaded.code, { filename: loaded.filename });
};

// 语法错误会抛 SyntaxError，与 jsc 的行为一致
globalThis.checkSyntax = function (file) {
    var loaded = source(file);
    new vm.Script(loaded.code, { filename: loaded.filename });
};

var args = process.argv.slice(2);
if (args[0] === "-e" && args.length > 1) {
    vm.runInThisContext(args[1], { filename: "-e" });
} else if (args.length === 1) {
    globalThis.load(args[0]);
} else {
    console.error("用法：node scripts/jsc_shim.js 文件.js | -e 代码");
    process.exit(2);
}
