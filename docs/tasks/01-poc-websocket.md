# 任务卡 1：真机验证 Bob `$websocket` 直连 Edge TTS

> **已归档**：这是 2026-09-27 开发时的任务卡，任务已完成并合并到 main，留作设计记录。文中提到的分支 `claude/gallant-bardeen-stykfj` 已删除，直接克隆 main 即可。

> 用法：本地还没有仓库的话，先克隆并切到本文件所在分支，再在该目录新开一个 Claude Code 会话，把本文件全文作为第一条消息贴进去；或者自己按步骤手动执行。预计 15–30 分钟。
>
> ```bash
> git clone https://github.com/poyih/bob-plugin-edge-tts.git
> cd bob-plugin-edge-tts && claude
> ```

## 目标

回答一个问题：**Bob 插件运行时的 `$websocket` 能不能直连微软 Edge「大声朗读」TTS 接口并正确收到二进制音频？** 这是「免 Key Edge TTS Bob 插件」是否成立的前提。此前的可行性研究（见 `docs/feasibility.md`）是在无外网的沙箱里完成的，下面两点无法验证，只能真机测：

1. `$websocket.new()` 是否把自定义握手头（User-Agent / Origin / Cookie）原样发出去。2025-12 起微软要求 UA 必须像 Edge 浏览器，否则拒绝握手或不返回音频。
2. `listenReceiveData` 回调拿到的 `$data` 是否是完整的一帧，以及当前 Bob 版本里 `$data` 到底有哪些取字节的手段（`length` / `toByteArray()` / `readUInt8(i)` / `toHex()` / `subData`）。注意：poyih/bob-plugin-vercel-tts 的 `scripts/test_plugin.js` 里有注释说真机 `$data` 没有 `length` 属性，但 Bob 官方 websocket 文档示例又打印了 `data.length`，需要实测定论。

仓库 poyih/bob-plugin-edge-tts 目前除文档外没有代码。

## 第 0 步：确认当前网络下接口本身可用（2 分钟）

```bash
uvx edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好，世界" --write-media /tmp/edge-poc.mp3 && afplay /tmp/edge-poc.mp3
# 没有 uv 就用：pipx run edge-tts --voice ... --text ... --write-media /tmp/edge-poc.mp3
```

失败（403 / NoAudioReceived）说明微软侧当前不可用或本网络被限，把结果写进报告后停止，不必继续。

## 第 1 步：读 Bob 官方文档，记下精确 API

- https://bobtranslate.com/plugin/api/websocket.html ：`$websocket.new` 的参数名是 `header` 还是 `headers`；`listenOpen / listenClose / listenError / listenReceiveString / listenReceiveData` 的回调签名；`sendString`；`timeoutInterval` 的单位；最低 Bob 版本。
- https://bobtranslate.com/plugin/api/data.html ：`$data` 的全部构造方法与实例方法。
- https://bobtranslate.com/plugin/api/log.html ：日志文件位置，用来看 `$log` 输出。
- 插件文档里 TTS 类插件的接口说明：`tts(query, completion)`、`query.text` / `query.lang`、返回 `{ result: { type: 'base64', value, raw } }`，错误返回 `{ error: { type, message, addtion } }`。

## 第 2 步：写最小 PoC 插件

目录 `poc/`（只是验证用，不是正式插件）：`poc/info.json`（category 为 tts，一个空 options 即可）和 `poc/main.js`。main.js 只做一件事：在 `tts()` 里连 Edge 接口、发两条消息、把每一帧的信息 `$log.info` 出来、收到 turn.end 后把拼好的 mp3 以 base64 交给 completion。

协议（已按 rany2/edge-tts 7.2.8 源码核对；动手前可再看一眼 GitHub 上 `src/edge_tts/constants.py` 的最新 UA 和版本号）：

```
URL:
wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
  ?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4
  &ConnectionId=<32 位 hex 随机>
  &Sec-MS-GEC=<见下>
  &Sec-MS-GEC-Version=1-143.0.3650.75

握手头:
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0
Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold
Cookie: muid=<32 位大写 hex 随机>;
Pragma: no-cache
Cache-Control: no-cache
Accept-Language: en-US,en;q=0.9
（Sec-WebSocket-* 由 WebSocket 客户端自己生成，不要手填）
```

Sec-MS-GEC 算法：

```
sec   = 当前 Unix 秒 + 11644473600        // 换到 Windows FILETIME 纪元
sec   = floor(sec / 300) * 300           // 向下取整到 5 分钟
ticks = String(sec) + "0000000"          // 乘 10^7；用字符串拼接，避免超过 2^53 的浮点问题
gec   = SHA256(ticks + "6A5AA1D4EAFF4E9FB37E23D68491D6F4")   // hex 大写
```

Bob 运行时没有 crypto，需要内嵌一段纯 JS SHA-256。已知答案用于自测：

- Unix 1700000000 → 待哈希字串 `1334447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4` → `42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF`
- Unix 1760000000.789 → `1340447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4` → `70AED27457006C255086B4F079B9FE44A4D10827C4AFDFC3C45583B6F40D7DDF`
- SHA256("abc") = `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`

连上后依次发两条文本帧（行尾必须是 `\r\n`）：

```
X-Timestamp:<日期>\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n
```

```
X-RequestId:<32 位 hex 随机>\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:<日期>Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='zh-CN-XiaoxiaoNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>你好，世界</prosody></voice></speak>
```

`<日期>` 形如 `Thu Sep 25 2026 10:00:00 GMT+0000 (Coordinated Universal Time)`，即 UTC 时间的 JS `Date.toString()` 风格；ssml 那条末尾多一个 `Z` 是微软侧的历史 bug，要照抄。文本必须做 XML 转义。

回包：

- 文本帧：头里 `Path:` 为 `turn.start` / `response` / `audio.metadata` / `turn.end`。收到 `turn.end` 即合成完毕，关闭连接。
- 二进制帧：前 2 字节大端整数 N 是头文本长度；头文本占字节 [2, 2+N)，形如 `X-RequestId:...\r\nContent-Type:audio/mpeg\r\nPath:audio`；音频数据从偏移 2+N 开始。结束前可能有一帧 `Path:audio` 但没有 Content-Type 也没有数据，忽略即可。

PoC 里每一帧都要打日志：文本帧打前 200 字符；二进制帧打 `typeof data`、`typeof data.length`、`typeof data.toByteArray`、`typeof data.readUInt8`、`typeof data.toHex`、`typeof data.subData`、解析出的 N 和头文本、音频字节数。握手失败时把 `listenError` 的 error 对象 JSON 打出来。用 `$data.fromData` / `appendData` 拼接音频，turn.end 时 `completion({ result: { type: 'base64', value: audio.toBase64(), raw: {} } })`。

打包安装：

```bash
mkdir -p dist && (cd poc && zip -qrX ../dist/edge-tts-poc.bobplugin . -x '*.DS_Store') && open dist/edge-tts-poc.bobplugin
```

在 Bob 偏好设置 → 服务 → 语音合成 里添加该插件，分别朗读一句中文和一句英文（英文把音色换成 `en-US-AriaNeural`）。

## 第 3 步：写报告并提交

把结论写到 `docs/poc-findings.md`：

1. 网络检查结果。
2. Bob 版本号；`$websocket.new` 的准确参数名与各回调签名。
3. 握手是否成功。若 403，分别尝试：去掉 Cookie、换 UA、校准系统时间，记录哪一项起作用。
4. `$data` 实测可用的方法，以及 listenReceiveData 每次是否给完整一帧。
5. 中英文是否都能播放、音频字节数与耗时。
6. 给正式实现的建议：帧解析走 toByteArray 还是 toHex；参数名是 header 还是 headers。

连同 `poc/` 一起提交到新分支（例如 `poc/edge-tts-websocket`），不要推 main，不要做正式发布。

## 参考

- 协议参考实现：https://github.com/rany2/edge-tts （LGPL-3.0，只参考协议事实，不要复制代码）
- Bob 第三方插件 akl7777777/bob-plugin-akl-microsoft-free-tts 的 `src/main2.js` 有 `$websocket.new({ url, allowSelfSignedSSLCertificates, timeoutInterval, header: {...} })` 加 `listenOpen / listenError / listenReceiveData / listenReceiveString` 的调用样例，可对照。
