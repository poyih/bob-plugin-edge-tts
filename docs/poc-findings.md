# PoC 结论：Bob `$websocket` 直连 Edge「大声朗读」

> 实测日期 2026-09-27。环境：Bob 1.21.0 (260)，macOS 27.0.0，家宽网络。第 11 节是 2026-09-28 按 `docs/tasks/03-verify-on-device.md` 在同一台机器上做的复核。
> 步骤见 `docs/tasks/01-poc-websocket.md`。验证插件 `poc/`、脚本 `scripts/poc/` 和原始日志 `docs/poc-evidence/` 都在 `poc/edge-tts-websocket` 分支上。

## 结论

可行。任务卡提出的两个疑问都有了确定答案：

1. **握手头能原样发出。** `$websocket.new` 的参数名是单数 `header`，User-Agent、Origin、Cookie 都原样出现在线路上。写成复数 `headers` 会被整个忽略。
2. **二进制帧每次都是完整一帧。** TCP 拆包、WebSocket 分片、72 KB 的大帧都被正确还原成一次 `listenReceiveData` 回调。真机 `$data` 没有 `length` 属性，取字节要用 `toByteArray()`。

中文和英文都在 Bob 里合成并播放成功。

另有一个没预料到的发现，直接影响正式插件的设计：**连接失败时 Bob 不给任何回调。** 连接被拒、域名不存在、TCP 被掐断、握手后服务端沉默，这四种情况下 `listenError` 和 `listenClose` 都不会来，`timeoutInterval` 也不起作用。插件必须自带定时器。详见第 6 节。

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
| 不传握手头 | 同上 | 同上 | 约 0.6 到 0.8 秒 |
| 本机探针直接回 403 | 同上 | 同上 | 8 毫秒 |

三种情况都只来了 `listenError`，之后 1.5 秒内没有 `listenClose`。HTTP 状态码只出现在 `message` 的文本里，`code` 恒为 0。两次独立运行的结果一致。

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

## 6. 故障时 Bob 的回调

由本机探针扮演出故障的服务端，另加两种连不上的地址。每种场景里 PoC 自己挂了一个 8 秒的定时器，到点后再观察 1.5 秒。

| 场景 | Bob 给的回调 | 期间的 `readyState` |
|---|---|---|
| 握手回 403 | `listenError`，见 3.3 | 3 |
| 服务端发 Close 帧，code 1011 | `listenClose`，code 是 1011，reason 是 `server going away`。没有 `listenError` | 3 |
| TCP 被直接掐断，没有 Close 帧 | **没有任何回调** | 一直是 1 |
| 握手成功后服务端一声不吭 | **没有任何回调** | 一直是 1 |
| 连接被拒，地址是 `ws://127.0.0.1:1` | **没有任何回调** | 一直是 0 |
| 域名不存在，地址是 `wss://edge-tts-poc.invalid` | **没有任何回调** | 一直是 0 |

后三种场景把 `timeoutInterval` 设成了 3 秒，结果 9.5 秒的观察期内什么都没发生。`timeoutInterval` 不能指望。

TCP 被掐断之后 `readyState` 仍然是 1，所以也不能靠轮询 `readyState` 来发现断线。

音色读不了当前语言时，微软的表现是正常握手、正常返回 `turn.start` 和 `response`，然后只发一帧 105 字节的空音频帧就 `turn.end`。实测用 en-US-AriaNeural 读中文得到的就是这个结果。

## 7. 其他发现

- **`close()` 不带参数会让 Bob 记一条未捕获异常。** 日志里出现 `TypeError: undefined is not an object (evaluating 'socket.close()')`，连接仍然正常关闭，插件侧的 try/catch 也捕获不到。`close({})` 和 `close({ code: 1000 })` 都没有这个问题。官方文档的示例恰好是不带参数的写法。
- **主动关闭后 `listenClose` 收到的是 code 1000、reason `cancelled`。** 这是客户端自己关闭的回声，不是错误。
- **Bob 先判断语种，再决定要不要调用插件。** 语种不在 `supportLanguages()` 里时 Bob 直接报「获取音频失败」，`tts` 根本不会被调用。纯网址的文本会被判成德语。
- **`$http` 能读到响应头。** `resp.response.headers.Date` 可用，键名区分大小写，`headers.date` 是 `undefined`。用它测得本机与微软服务器相差 1 秒。握手被拒时拿不到响应头，时钟偏差兜底要走这条路。
- **`$http` 返回的 `data` 已经解析成数组。** 音色列表当前有 322 个音色。
- **`toHex(true)` 返回大写。** `toHex()` 和 `toHex(false)` 返回小写。
- **音色列表地址不接受 HEAD。** 2026-09-28 复核：HEAD 回 404（带 Date 头），GET 回 200、171 KB 且不压缩，两者都约 0.6 秒。校时探测继续用 GET，见 11.6。

## 8. 给正式实现的建议

1. 握手头放在 `header` 里，必须带 Edge 的 User-Agent。Cookie 和 Origin 目前可省，为了与 Edge 行为一致仍建议带上。
2. 帧解析走 `toByteArray()`，不要依赖 `length`，不要用 `subData` 取帧尾，不要用 `toHex`。
3. 关闭连接写 `socket.close({})`。
4. 还没 `listenOpen` 就来了 `listenError` 或 `listenClose`，一律按握手失败处理。不要指望 `error.code`，状态码只在 `message` 里。
5. 握手失败后用 `$http` 请求音色列表，读 `Date` 头估算时钟偏差，重签一次再试。查响应头要忽略大小写。
6. `supportLanguages()` 决定了 Bob 会把哪些语言交给插件，语言表要尽量全。
7. `completion` 要防重：主动关闭之后还会来一次 `listenClose`。
8. 超时全部由插件自己的 `$timer` 负责，至少三条期限：握手多久没完成、连上之后多久没收到数据、整条连接多久没结束。不要依赖 `timeoutInterval`，也不要等 `listenError`。

## 9. 尚未验证

| 项目 | 状态 |
|---|---|
| 真的把系统时间调偏 | 未做。目前只用错误的时间签名来模拟 |
| 连接失败的回调是否会在更久之后到来 | 只观察了 9.5 秒。Bob 默认的 `timeoutInterval` 是 60 秒，不排除那时才报错 |
| 不带参数的 `close()` 记异常 | 只观察到一次，之后的运行都改用 `close({})`，没有再出现 |
| 从插件入口建立的连接为什么慢 | 推测是 Bob 在低优先级队列上执行插件入口、拖慢了用户态 TCP 的 ACK，没有 root 工具确认队列 QoS，见 11.4 |
| 手机热点等其他网络下的并发 | 未做，并发只在家宽下测过 |

## 10. 复现方法

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

## 11. 2026-09-28 复核：1.1.0 的兜底逻辑、分段并发与校时

环境同上。用来制造故障的本机假服务端是 `scripts/live/fake_edge.py`，插件要连过去得装一个改了 `WSS_URL` 的临时包。并发的测量脚本是一次性的，没有收进仓库，数据都记在下面。

### 11.1 兜底逻辑

| 操作 | 结果 |
|---|---|
| 全局固定为 Aria，朗读中文 | Aria 没有返回音频，插件改用晓晓重试，2.6 秒完成，日志记为 `done voice=zh-CN-XiaoxiaoNeural(fallback) ... retries=1` |
| 同样的设置朗读英文 | Aria 直接读，`retries=0` |
| 按语言指定 `fr=fr-FR-HenriNeural; de=de-DE-ConradNeural` | 法语由 Henri、德语由 Conrad 朗读，来源记为 `map` |
| 点「验证」 | 全局 Aria 时合成 Hi，按语言自动时合成「你好」，都显示验证成功 |
| 把 WSS 地址换成不存在的域名 | 10.0 秒后报「连接不上微软语音服务（握手 10 秒内没有完成）」，Bob 没有卡住 |

断网测试没有真的关 Wi-Fi，用不存在的域名代替，与第 6 节「域名不存在」是同一种情形。

插件连到本机假服务端后：

| 假服务端的行为 | 插件的表现 |
|---|---|
| 第一次发一帧后 Close 1011，第二次正常 | 重试 1 次成功，共 0.2 秒 |
| 第一次握手后一声不吭 | 15 秒空闲看门狗触发，重试 1 次成功 |
| 连续两次握手回 503 | 先校时（偏差 0 秒）重签，再按瞬时故障重试 1 次，第三次成功，共 1.5 秒 |
| 每次都 Close 1011 | 重试 2 次后报「微软接口中途关闭了连接」，共 0.6 秒 |
| 发一帧后直接断 TCP | Bob 照旧不给任何回调，15 秒空闲看门狗兜底，重试 1 次成功 |
| 第一次只回 turn.end、没有音频 | 同一音色重试 1 次成功 |

### 11.2 Bob 会把换行换成空格

朗读一段 45 行的编号列表时，插件收到的文本里一个换行都没有（换行和回车都是 0 个），换行都变成了空格。1.1.0 的「换行优先切分」在 Bob 里用不上：「……同步给大家。 30. 第30条」这样的文本，在 61 种对齐里有 59 种会切在「30.」后面，把下一条的编号读到上一段末尾。1.2.0 认出这种列表编号，把切点放在编号前面，在 Bob 里复测，第二段从「30. 第30条」开始。

### 11.3 多行文本框

`textConfig` 里写 `height: 60` 有效：「按语言指定音色」的输入框高 62 像素，其他文本框是 23 像素。

### 11.4 从插件入口建立的连接收得慢

在 Bob 里，每次朗读建立的第一条连接，音频以约 240 KB/s 的速度匀速到达：一段 2900 字节的中文，音频约 1.26 MB，要 5 到 7 秒才收完。在 WebSocket 回调里建立的后续连接约 1 MB/s，同样大小的一段只要 2 秒左右。联网宿主里没有这个现象，第一条连接也是 2 秒左右。

| 对照 | 第一条连接 | 第二条连接 |
|---|---|---|
| Bob，按原顺序读 2 段 | 5.9 到 6.0 秒，匀速慢收 | 2.0 到 2.2 秒 |
| Bob，只读原来的第 2 段 | 5.8 秒，匀速慢收 | 没有第二条 |
| Bob，两段内容对调 | 8.4 秒，匀速慢收 | 2.3 秒 |
| Bob，第一条连接推迟 10 毫秒，在 `$timer` 回调里建立 | 6.3 到 7.3 秒 | 2.2 到 2.3 秒 |
| Bob，第一条连接在一次本机 `$http` 请求的回调里建立 | 6.6 到 7.2 秒 | 没有第二条 |
| Bob，点偏好设置里的「验证」，由 `pluginValidate` 合成同样长的文本 | 6.1 秒 | 没有第二条 |
| Bob，两次朗读紧挨着，间隔不到 3 秒 | 6.0 秒和 8.3 秒 | 没有第二条 |
| 宿主，与 Bob 完全相同的文本 | 2.4 秒 | 2.0 秒 |
| 宿主，先空闲 25 秒再建连接，重复 7 次 | 1.1 到 1.6 秒 | 没有第二条 |

规律是：从插件入口建立的连接都慢，入口指 `tts()`、`pluginValidate()`、`$timer` 回调、`$http` 回调；在 WebSocket 事件回调里建立的连接都快。与文本内容、空闲多久、是不是当次的第一条连接都无关。每 250 毫秒一次的心跳定时器最大延迟只有 2 到 81 毫秒，JS 线程没有被卡住。

慢在服务端发得慢，不在 Bob 读得慢。传输过程中每 0.5 秒看一次 `netstat -anv`，两条连接的内核接收队列（Recv-Q）始终是 0。nettop 显示两条都是普通流量类别（BE），往返时延约 25 毫秒，接收缓冲 256 KiB 起。接收窗口一直开着，数据来了就被取走，服务端却只按每秒 31 到 40 万字节在发，同时另一条连接能到每秒 100 万以上。

用 `sample` 看 Bob 进程，调用栈里有 `tcp_output`、`tcp_usr_rcvd`、`tcp_process_timerlist`、`nw_channel_*`，说明 Bob 的 WebSocket（Starscream 4，底层 NWConnection）走的是 Network.framework 的用户态 TCP：ACK 和窗口更新由 Bob 进程自己的线程在连接的派发队列上处理。最说得通的解释是 Bob 在较低优先级的队列上执行插件入口，从那里建立的连接，其用户态 TCP 处理也跟着低优先级，ACK 回得慢，服务端的发送被 ACK 节奏限住；WebSocket 回调在较高优先级的队列上，从那里建立的连接不受影响。要看到队列的 QoS 需要 root 权限的 spindump，没有做，所以这仍是推测。宿主用 URLSession，没有这个现象。

插件没法改变入口的优先级。试过在第一条连接的 open 回调里重建连接，对短文本会多等一次握手，得不偿失。1.2.0 的办法是让入口建立的那条连接只读很少的内容：见 11.5 的首段切短。

### 11.5 分段并发与首段切短

1.2.0 的做法：第 1 段收到第一帧音频之后（签名和音色都已确认没问题），后面的段最多两条连接同时在途，已启动但还没按顺序拼好的段不超过两段。转义后超过 900 字节的文本，第 1 段只切 300 字节以内的一两句，它很快出声放闸，大块内容交给后面的快连接。

先在联网宿主里比较并发数，只分段、不切短首段，每种 5 次，轮流进行，没有一次重试或报错：

| 文本 | 串行中位数 | 2 路 | 省 | 3 路 | 省 |
|---|---|---|---|---|---|
| 2 段 | 4.3 秒 | 3.3 秒 | 24% | 3.1 秒 | 28% |
| 3 段 | 8.4 秒 | 4.4 秒 | 48% | 3.6 秒 | 58% |
| 4 段 | 8.6 秒 | 5.0 秒 | 42% | 3.5 秒 | 59% |

同样的对比在 Bob 里各做 3 次，收益小得多，原因就是 11.4 的慢连接：第 1 段要 6 秒左右，把后面的段堵住了。

| 文本 | 串行中位数 | 2 路 | 省 | 3 路 | 省 |
|---|---|---|---|---|---|
| 2 段 | 8.5 秒 | 6.7 秒 | 22% | 6.4 秒 | 25% |
| 3 段 | 9.8 秒 | 8.2 秒 | 16% | 6.5 秒 | 33% |
| 4 段 | 11.8 秒 | 9.2 秒 | 22% | 7.7 秒 | 35% |

加上首段切短后在 Bob 里再比，各 3 次。放宽窗口指同时在途不超过两条、已启动未拼好的不超过三段，没有额外收益，1.2.0 没有采用：

| 文本 | 串行中位数 | 2 路加首段切短 | 省 | 再放宽窗口 | 省 |
|---|---|---|---|---|---|
| 1 段（约 2900 字节） | 6.5 秒 | 3.1 秒 | 52% | 3.2 秒 | 50% |
| 2 段 | 8.9 秒 | 3.6 秒 | 60% | 3.7 秒 | 59% |
| 4 段 | 12.3 秒 | 5.3 秒 | 57% | 5.8 秒 | 53% |

最后用 1.2.0 的正式代码（不带任何调试日志）与关掉这两项的同一份代码（即 1.1.0 的行为）在 Bob 里对照，各 3 次：

| 文本 | 1.1.0 的行为 | 1.2.0 | 省 |
|---|---|---|---|
| 一句话（约 40 字，一段，不切短） | 1.4 秒 | 1.2 秒 | 不受影响 |
| 约 390 字（1158 字节） | 3.1 秒 | 2.4 秒 | 22% |
| 约 990 字（原本 1 段） | 6.2 秒 | 3.2 秒 | 48% |
| 约 2000 字（原本 2 段） | 8.6 秒 | 3.5 秒 | 60% |
| 约 3150 字（原本 4 段） | 12.5 秒 | 5.9 秒 | 53% |

在联网宿主里，首段切短会让 1 到 2 段的文本慢 0.4 到 0.6 秒，因为宿主的第一条连接本来就不慢。插件只跑在 Bob 里，按 Bob 的实测取舍。

上面 Bob 里 84 次计时的合成全部完成，没有出现 403、429、1011、无音频或任何重试；宿主里 45 次并发对比同样如此，另外约 30 次宿主对比也全部完成。没有看到限流的迹象。

### 11.6 校时探测不改用 HEAD

```bash
curl -sI -A "<Edge 的 User-Agent>" "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=..."
```

连续三次都回 `HTTP/2 404`，带 `date` 头，约 0.6 到 0.8 秒；同一地址 GET 回 200，`content-length: 170998`，带 `Accept-Encoding: gzip` 也不压缩，约 0.6 到 0.9 秒。按任务卡的标准，HEAD 不是 200 就不改：省下的只是握手被拒时一次性的 171 KB，家宽下耗时没有差别，不值得依赖一个 404。Bob 一侧的 `$http` 是否支持 HEAD 因此没有再测。
