# PoC 结论：Bob `$websocket` 直连 Edge「大声朗读」

> 实测日期 2026-09-27。环境：Bob 1.21.0 (260)，macOS 27.0.0，家宽网络。
> 步骤见 `docs/tasks/01-poc-websocket.md`，验证插件在 `poc/`，原始日志在 `docs/poc-evidence/`。

## 结论

可行。任务卡提出的两个疑问都有了确定答案：

1. **握手头能原样发出。** `$websocket.new` 的参数名是单数 `header`，User-Agent、Origin、Cookie 都原样出现在线路上。写成复数 `headers` 会被整个忽略。
2. **二进制帧每次都是完整一帧。** TCP 拆包、WebSocket 分片、72 KB 的大帧都被正确还原成一次 `listenReceiveData` 回调。真机 `$data` 没有 `length` 属性，取字节要用 `toByteArray()`。

中文和英文都在 Bob 里合成并播放成功。

## 1. 网络检查

```bash
uvx edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好，世界" --write-media /tmp/edge-poc.mp3
```

成功，得到 11664 字节的 mp3。当前网络下微软接口可用。

## 2. Bob 运行时的精确 API

以下成员名由 PoC 在真机上枚举得到，不是抄文档。

| 对象 | 成员 |
|---|---|
| `$websocket` | `new` |
| socket 实例 | `open` `close` `sendString` `sendData` `ping` `pong` `listenOpen` `listenClose` `listenError` `listenReceiveString` `listenReceiveData` `listenReceivePing` `listenReceivePong` `readyState` |
| `$data` | `fromUTF8` `fromHex` `fromBase64` `fromByteArray` `fromData` `isData` |
| `$data` 实例 | `toUTF8` `toHex` `toBase64` `toByteArray` `readUInt8` `writeUInt8` `subData` `appendData` |
| `$timer` | `schedule` `invalidate` |

`$websocket.new` 接受 `url`、`allowSelfSignedSSLCertificates`、`timeoutInterval`、`header`。

回调实际收到的参数：

| 回调 | 参数个数 | 内容 |
|---|---|---|
| `listenOpen` | 1 | socket，与 `new` 返回的是同一个对象 |
| `listenReceiveString` | 2 | socket，string |
| `listenReceiveData` | 2 | socket，`$data` |
| `listenError` | 2 | socket，`{ type, code, message }` |
| `listenClose` | 3 | socket，code 为 number，reason 为 string |

`readyState` 的实测取值：调用 `open()` 之前和握手失败之后是 3，`listenOpen` 时是 1，调用 `close` 之后是 2，`listenClose` 时是 3。

`$timer.schedule({ interval, repeats, handler })` 返回 number 类型的 id。`sendString` 返回 `undefined`。

`tts(query, completion)` 的 `query` 只有 `lang` 和 `text` 两个键。

## 3. 握手

### 3.1 Bob 实际写到线路上的请求

用本机探针 `scripts/poc/probe_server.py` 抓包，同一段文本连三次：

| 传参方式 | 线路上出现的自定义头 |
|---|---|
| 放在 `header` 里 | User-Agent、Origin、Cookie、Pragma、Cache-Control、Accept-Language 全部原样出现 |
| 什么都不传 | 只有 Bob 自带的 Host、Upgrade、Connection、Sec-WebSocket-Key、Sec-WebSocket-Version，以及自动生成的 `Origin: ws://127.0.0.1:18765` |
| 放在 `headers` 里 | 与什么都不传完全一样，`headers` 被忽略 |

`header` 方式抓到的原始请求：

```
GET /probe?TrustedClientToken=...&ConnectionId=...&Sec-MS-GEC=...&Sec-MS-GEC-Version=1-143.0.3650.75 HTTP/1.1
Host: 127.0.0.1:18765
Pragma: no-cache
Sec-WebSocket-Key: ZnNpZXZxZmhlb2dudmd1dQ==
Sec-WebSocket-Version: 13
Upgrade: websocket
Accept-Language: en-US,en;q=0.9
Cache-Control: no-cache
Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0
Connection: Upgrade
Cookie: muid=954CCA237036995628F02D85DB32F05C;
```

两条文本消息也与协议逐字节一致：行尾是 `\r\n`，ssml 那条的 X-Timestamp 末尾带 `Z`。

### 3.2 微软当前校验什么

在 Bob 之外用同一台机器、同一条网络逐项去掉握手头，脚本是 `scripts/poc/edge_header_matrix.py`：

| 用例 | 握手 | 音频 |
|---|---|---|
| 完整握手头 | 101 | 11664 字节 |
| 去掉 Cookie | 101 | 11664 字节 |
| 去掉 Origin | 101 | 11664 字节 |
| 只带 Edge 的 User-Agent | 101 | 11664 字节 |
| 去掉 User-Agent | 403 | 无 |
| User-Agent 换成 Chrome | 403 | 无 |
| User-Agent 换成 Safari | 403 | 无 |
| User-Agent 换成 CFNetwork 风格 | 403 | 无 |
| 什么自定义头都不带 | 403 | 无 |
| 完整握手头，签名时间慢 10 分钟 | 403 | 无 |

微软现在校验两样东西：User-Agent 必须像 Edge，Sec-MS-GEC 的时间必须准。Cookie 和 Origin 目前可省。

因为不带 Edge 的 User-Agent 必然 403，所以 Bob 里握手成功本身就证明自定义 User-Agent 确实发出去了，与 3.1 的抓包互相印证。

### 3.3 握手被拒时 Bob 里的样子

| 场景 | 回调 | error 对象 | 耗时 |
|---|---|---|---|
| 签名时间偏 900 秒 | `listenError`，`readyState` 为 3 | `{"type":"unknownError","code":0,"message":"notAnUpgrade(403)"}` | 约 0.7 秒 |
| 不传握手头 | 同上 | 同上 | 约 0.6 秒 |

两种情况都只来了 `listenError`，之后 1.5 秒内没有 `listenClose`。HTTP 状态码只出现在 `message` 的文本里，`code` 恒为 0。

## 4. 二进制帧与 `$data`

### 4.1 帧完整性

探针故意用四种方式发音频帧，Bob 每次都回调了完整的一帧：

| 探针的发送方式 | 消息长度 | Bob 回调收到的长度 |
|---|---|---|
| 单帧，一次写完 | 2085 | 2085 |
| 单帧，拆成 3 次 TCP 写入，间隔 150 毫秒 | 2085 | 2085 |
| WebSocket 分片成 3 片 | 2085 | 2085 |
| 64 位长度的大帧 | 72085 | 72085 |
| 无 Content-Type 的结束帧 | 60 | 60 |

三次连接拼出的音频都是 78000 字节，SHA-256 与探针发送的原始音频一致。

微软真实返回的帧：普通帧 850 字节，其中头文本 128 字节、音频 720 字节。最后一个音频帧较短。`turn.end` 之前还有一帧 105 字节的 `Path:audio`，没有 Content-Type 也没有音频，要忽略。文本帧依次是 `turn.start`、`response`、若干 `audio.metadata`、`turn.end`，`audio.metadata` 会穿插在音频帧之间。

### 4.2 `$data` 的真实语义

| 项目 | 实测 |
|---|---|
| `length` | 不存在。`typeof data.length` 是 `undefined`，`byteLength`、`count`、`size` 也都没有 |
| `toByteArray()` | 返回普通数组，可以取 `.length` |
| `readUInt8(i)` | 越界返回 0，不抛异常 |
| `subData(start, end)` | 返回 `[start, end)`，但要求 `end` 小于总长度。10 字节的数据上 `subData(0, 10)` 返回 `undefined`，最后一个字节取不到 |
| `appendData(other)` | 原地修改，返回 `undefined` |
| `writeUInt8(value, index)` | 原地修改 |
| `fromData(d)` | 得到独立副本，之后对副本 `appendData` 不影响原对象 |
| `fromHex("FFF3").toUTF8()` | 不是合法 UTF-8 时返回 `undefined` |
| `String(d)` | `[object Bob.JSData]` |

200 KB 数据上的耗时：

| 操作 | 毫秒 |
|---|---|
| `toByteArray` | 9 |
| `toBase64` | 小于 1 |
| `fromByteArray` | 24 |
| `toHex` | 645 |
| 200 次 `subData` 加 `appendData` | 1 |

`toHex` 明显慢，不适合用来逐帧解析。

官方文档的示例里写了 `data.length`，与 1.21.0 的实际行为不符。

## 5. 朗读结果

| 文本 | 音色 | 音频字节 | 握手完成 | 首个音频帧 | turn.end | Bob 播放 |
|---|---|---|---|---|---|---|
| 你好，世界 | zh-CN-XiaoxiaoNeural | 11664 | 570 毫秒 | 760 毫秒 | 855 毫秒 | 成功 |
| 一句 68 个字符的英文 | en-US-AriaNeural | 37584 | 696 毫秒 | 975 毫秒 | 1191 毫秒 | 成功 |

两次都没有畸形帧。`completion({ result: { type: "base64", value, raw } })` 交回的 mp3 被 Bob 正常播放。

## 6. 其他发现

- **`close()` 不带参数会让 Bob 记一条未捕获异常。** 日志里出现 `TypeError: undefined is not an object (evaluating 'socket.close()')`，连接仍然正常关闭，插件侧的 try/catch 也捕获不到。`close({})` 和 `close({ code: 1000 })` 都没有这个问题。官方文档的示例恰好是不带参数的写法。
- **主动关闭后 `listenClose` 收到的是 code 1000、reason `cancelled`。** 这是客户端自己关闭的回声，不是错误。
- **Bob 先判断语种，再决定要不要调用插件。** 语种不在 `supportLanguages()` 里时 Bob 直接报「获取音频失败」，`tts` 根本不会被调用。纯网址的文本会被判成德语。
- **`$http` 能读到响应头。** `resp.response.headers.Date` 可用，键名区分大小写，`headers.date` 是 `undefined`。用它测得本机与微软服务器相差 1 秒。握手被拒时拿不到响应头，时钟偏差兜底要走这条路。
- **`$http` 返回的 `data` 已经解析成数组。** 音色列表当前有 322 个音色。

## 7. 给正式实现的建议

1. 握手头放在 `header` 里，必须带 Edge 的 User-Agent。Cookie 和 Origin 目前可省，为了与 Edge 行为一致仍建议带上。
2. 帧解析走 `toByteArray()`，不要依赖 `length`，不要用 `subData` 取帧尾，不要用 `toHex`。
3. 关闭连接写 `socket.close({})`。
4. 还没 `listenOpen` 就来了 `listenError` 或 `listenClose`，一律按握手失败处理。不要指望 `error.code`，状态码只在 `message` 里。
5. 握手失败后用 `$http` 请求音色列表，读 `Date` 头估算时钟偏差，重签一次再试。查响应头要忽略大小写。
6. `supportLanguages()` 决定了 Bob 会把哪些语言交给插件，语言表要尽量全。
7. `completion` 要防重：主动关闭之后还会来一次 `listenClose`。

## 8. 尚未验证

会话中途因用量上限中断，以下几项没有跑完：

| 项目 | 状态 |
|---|---|
| 连接被拒时的回调形态 | 诊断模式第 5 步刚发起，结果没有录到 |
| 域名不存在时的回调形态 | 未跑 |
| 握手直接回 403、服务端发 Close 帧、TCP 被掐断、握手后无响应 | 对应的「诊断二」模式已写好并通过离线自测，未在 Bob 里跑过 |
| `timeoutInterval` 到点后的回调形态 | 未跑 |
| 真的把系统时间调偏 | 未做。目前只用错误的时间签名来模拟 |

`poc/main.js` 在最后一次装进 Bob 之后又加了「诊断二」模式，这部分代码只经过离线自测。

## 9. 复现方法

```bash
# 离线自测
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc scripts/poc/test_poc.js

# 握手头对照实验
uv run --with aiohttp python scripts/poc/edge_header_matrix.py

# 打包安装
mkdir -p dist && (cd poc && zip -qrX ../dist/edge-tts-poc.bobplugin . -x '*.DS_Store') && open dist/edge-tts-poc.bobplugin

# 探针
python3 scripts/poc/probe_server.py --audio /path/to/sample.mp3 --port 18765 --log probe.log
```

在 Bob 的输入框里输入文本后点朗读按钮：

| 输入的文本 | 作用 |
|---|---|
| 任意中文或英文 | 正常合成，逐帧打日志 |
| `探针 ws://127.0.0.1:18765/probe` | 抓握手请求并验证帧完整性 |
| `诊断 poc-diag` | `$data` 语义、`$http` 读 Date 头、各种握手失败 |
| `诊断 poc-diag2 ws://127.0.0.1:18765` | 由探针扮演出故障的服务端 |

触发词前面要带几个汉字，否则 Bob 会把文本判成不支持的语种。日志在 Bob 菜单栏图标的「帮助」里导出，搜索 `[edge-poc]`。
