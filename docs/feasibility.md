# 可行性分析：用 Edge「大声朗读」接口做 Bob TTS 插件

> 2026-09-27，在无外网的沙箱里完成。Bob 官方文档站与 speech.platform.bing.com 均被沙箱出口代理拦截，Bob 侧结论来自作者已有插件源码与社区插件源码，Edge 侧结论来自 rany2/edge-tts 7.2.8 源码。两处待真机验证的点见文末与 `docs/tasks/01-poc-websocket.md`。

## 结论

可行。Bob 插件运行时具备实现 Edge TTS 所需的全部原语，已有社区插件用同一套 API 走通 WebSocket 与二进制音频拼接。不确定性全部来自微软一侧：这是 Edge 浏览器的内部接口，过去一年被收紧了三次。

## Bob 一侧：能力对照

| Edge TTS 需要 | Bob 插件运行时 | 依据 |
|---|---|---|
| WebSocket 客户端 | `$websocket.new({url, header, timeoutInterval})`，`open / sendString / listenOpen / listenError / listenReceiveString / listenReceiveData` | 官方 API 页；akl7777777/bob-plugin-akl-microsoft-free-tts 的 `src/main2.js` |
| 自定义握手头 UA、Origin、Cookie | `new()` 接受 header 对象 | 同上，能否真正覆盖 UA 需真机验证 |
| 收二进制帧并按字节解析 | 回调给 `$data`，有 `readUInt8 / toByteArray`，`length` 是否存在有矛盾记录 | poyih/bob-plugin-openai-tts 用这几个方法做音频魔数校验；vercel-tts 测试桩注释称真机无 `length` |
| 拼接音频并转 base64 | `$data.fromByteArray / fromData / appendData / toBase64` | Littlecowherd/bob-plugin-doubao-tts 与 openai-tts 均在用 |
| SHA-256 生成 Sec-MS-GEC | 运行时无 crypto，需内嵌纯 JS 实现 | JavaScriptCore 无 WebCrypto |
| 交付给 Bob | `completion({result:{type:'base64', value, raw}})`，mp3 | 与作者现有插件一致 |

## 微软一侧：协议要点

- 端点 `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`，query 带 TrustedClientToken、ConnectionId、Sec-MS-GEC、Sec-MS-GEC-Version（当前 `1-143.0.3650.75`）。
- Sec-MS-GEC：Windows FILETIME 刻度向下取整到 5 分钟，拼 TrustedClientToken 后取 SHA-256 大写 hex。本机时钟偏差超过 5 分钟会 403。
- 握手头：Edge 的 UA、`Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`、随机 `Cookie: muid=...;`、no-cache。
- 消息序列：`Path:speech.config` 文本帧，outputFormat `audio-24khz-48kbitrate-mono-mp3`；再 `Path:ssml` 文本帧。头部用 CRLF，X-Timestamp 是 JS Date 字串再拼一个 Z。
- 回包：文本帧 turn.start / response / audio.metadata / turn.end；二进制帧前 2 字节大端为头长度，头内 `Path:audio`、`Content-Type:audio/mpeg`，其后是 mp3 数据。
- 单次约 4096 字节上限，长文本切段多次请求，48kbps CBR mp3 可直接拼接。文本需 XML 转义并剔除控制字符。
- voices/list 接口可做 pluginValidate；Bob 选项是静态的，音色下拉需内置表加自定义文本框兜底。

完整字段与已知答案测试向量见 `docs/tasks/01-poc-websocket.md`。

## 风险时间线

| 时间 | 事件 |
|---|---|
| 2024-10 | 新增 Sec-MS-GEC 校验，所有旧客户端 403（edge-tts issue 290） |
| 2025-08 | edge-tts 更换端点，UA 版本升到 140（7.2.2 / 7.2.3） |
| 2025-12-11 | 出现 NoAudioReceived，加 MUID cookie 并切回 macOS Edge 在用的端点才恢复（7.2.4 至 7.2.6）；同期第三方浏览器扩展被封死，UA 必须像 Edge |
| 2026-04 至 2026-07 | 仍有间歇性无音频与 503 握手失败的 open issue（473、481、482） |

影响：维护成本是跟着 edge-tts 上游更新 UA、版本号和请求头。数据中心 IP 会被限流，Bob 跑在用户 Mac 上是家宽 IP，反而有利。国内可直连。接口属于 ToS 灰色地带，不适合商业化承诺。相对 Bob 内置「Microsoft 语音合成」（需 Azure 密钥）的差异就是免费无 Key。

## 待真机验证

1. Bob 的 `$websocket` 是否把 User-Agent、Origin、Cookie 原样写进握手请求。
2. `listenReceiveData` 是否每次给完整一帧；`$data` 在当前 Bob 版本可用的取字节方法；`new()` 参数名是 `header` 还是 `headers`。

## 备选

- Plan B：`$websocket` 走不通时，用本机或自建 HTTP 代理转发（akl 老方案）。缺点是常驻进程，或自建机器的数据中心 IP 被限。
- Plan C：Azure Speech 官方接口，每月有免费额度，稳定但要密钥，Bob 已内置。

## 参考

- https://bobtranslate.com/plugin/api/websocket.html
- https://bobtranslate.com/service/tts/microsoft.html
- https://github.com/rany2/edge-tts 及其 releases、issues 290 / 473 / 482
- https://github.com/Migushthe2nd/MsEdgeTTS 、https://github.com/travisvn/edge-tts-universal
- https://github.com/akl7777777/bob-plugin-akl-microsoft-free-tts 、https://github.com/Littlecowherd/bob-plugin-doubao-tts
