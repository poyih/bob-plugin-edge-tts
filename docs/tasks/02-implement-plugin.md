# 任务卡 2：实现 Edge TTS 免 Key Bob 插件

> 用法：在 Mac 上打开本仓库的本地克隆，新开一个 Claude Code 会话，把本文件全文作为第一条消息贴进去。建议先完成任务卡 1（`docs/tasks/01-poc-websocket.md`），其结论会写在 `docs/poc-findings.md`。

## 目标

在 poyih/bob-plugin-edge-tts 里实现一个 Bob 语音合成（TTS）插件，调用微软 Edge 浏览器「大声朗读」的 WebSocket 接口合成语音。卖点：完全免 API Key、国内直连、音色质量好。仓库目前除文档外没有代码。

前置：如果仓库里已有 `docs/poc-findings.md`（任务卡 1 的产出），先读它，按其中的实测结论决定 `$data` 的取字节方式和 `$websocket.new` 的参数名。如果没有，先按下文「协议」用一个最小插件在 Bob 里验证握手与二进制帧能通，再继续。

## 工程结构：照 poyih/bob-plugin-vercel-tts 的现行规范

- `src/info.json`、`src/main.js`、`src/config.js`（协议常量与音色表）、`src/icon.png`
- `Makefile`：`lint / test / pack / install / appcast / clean`。测试用 macOS 自带的 jsc（`/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc`，与 Bob 同一引擎）
- `scripts/test_plugin.js`：jsc 跑的离线单测，桩掉 `$websocket / $data / $option / $log / $http / $timer`，最后输出 `ALL PASS (n checks)`；`scripts/check_info.py`、`scripts/update_appcast.py` 用标准库 Python
- `.github/workflows/ci.yml`：macos-latest 跑 `make test`
- `appcast.json`：只放 identifier 和空的 versions 数组。**不要**登记版本，等 GitHub Release 资产存在后再由用户运行 `make appcast`
- `README.md` 中文，包含：特点 / 安装 / 设置项 / 已知限制 / 免责声明（非官方接口，微软可能随时变更）。LICENSE 沿用作者其他插件的许可证
- identifier `com.poyih.bob.plugin.edge.tts`；name `Microsoft Edge 语音合成`；`minBobVersion` 按 Bob 文档中 `$websocket` 的最低版本填，不低于 1.8.0
- Bob 运行时约束：JavaScriptCore，无 Node 和浏览器 API，只有 `$websocket $http $data $option $log $timer` 等 Bob 全局；`require('./config.js')` 与 `exports.*` 可用；代码用 ES5 风格的 `var` 与 function
- 导出 `supportLanguages`、`tts`、`pluginTimeoutInterval`、`pluginValidate`

## 协议（已按 rany2/edge-tts 7.2.8 源码核对）

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
（Sec-WebSocket-* 由客户端自动生成，不要手填）

音色列表（可用于核对 ShortName）:
https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4
```

Sec-MS-GEC：

```
sec   = 当前 Unix 秒 + 11644473600        // Windows FILETIME 纪元
sec   = floor(sec / 300) * 300           // 向下取整到 5 分钟
ticks = String(sec) + "0000000"          // 乘 10^7，用字符串拼接避免超过 2^53
gec   = SHA256(ticks + "6A5AA1D4EAFF4E9FB37E23D68491D6F4")   // hex 大写
```

已知答案：Unix 1700000000 → 待哈希字串 `1334447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4` → `42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF`；Unix 1760000000.789 → `1340447340000000006A5AA1D4EAFF4E9FB37E23D68491D6F4` → `70AED27457006C255086B4F079B9FE44A4D10827C4AFDFC3C45583B6F40D7DDF`；SHA256("abc") = `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`。

连上后依次发两条文本帧，行尾 `\r\n`：

```
X-Timestamp:<日期>\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n
```

```
X-RequestId:<32 位 hex 随机>\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:<日期>Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='VOICE'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>已转义文本</prosody></voice></speak>
```

`<日期>` 形如 `Thu Sep 25 2026 10:00:00 GMT+0000 (Coordinated Universal Time)`，UTC；ssml 那条末尾多一个 `Z` 是微软侧历史 bug，照抄。

回包：文本帧的 `Path:` 为 `turn.start` / `response` / `audio.metadata` / `turn.end`，收到 `turn.end` 即完成。二进制帧前 2 字节大端整数 N 是头文本长度，头文本占 [2, 2+N)，含 `Path:audio` 与 `Content-Type:audio/mpeg`，音频从 2+N 开始；结束前可能出现无 Content-Type 无数据的 `Path:audio` 帧，忽略。

## 功能要求

1. Sec-MS-GEC 签名与纯 JS SHA-256；MUID cookie 每次连接随机生成。
2. 时钟偏差兜底：握手失败疑似 403 时，用 `$http.request` 请求上面的音色列表地址，读响应 `Date` 头算出偏差，重签一次再试，仅重试一次。
3. 长文本分段：按 UTF-8 字节数不超过 3000 在标点或空白处切分，不破坏多字节字符和 XML 实体；每段新开一条连接顺序合成；48 kbps CBR mp3 可直接首尾拼接。文本做 XML 转义，控制字符 0–8、11、12、14–31 替换为空格。
4. 音色策略：`config.js` 内置「Bob 语言码 → 默认音色」表，至少覆盖 zh-Hans→zh-CN-XiaoxiaoNeural、zh-Hant→zh-TW-HsiaoChenNeural、yue→zh-HK-HiuMaanNeural、en→en-US-AriaNeural、ja→ja-JP-NanamiNeural、ko→ko-KR-SunHiNeural，以及 fr de es it ru pt nl pl ar hi tr vi th id ms uk cs da fi el he hu nb ro sk sv 等主流语言；实现时拉一次音色列表核对 ShortName，剔除不存在的。`supportLanguages()` 从这张表推导。
   info.json 选项：`voiceMode` 菜单（按语言自动 / 全局固定）、`globalVoice` 菜单（约 30 个常用音色，含 Multilingual 系列）、简中 / 繁中 / 粤语 / 英 / 日 / 韩 六个语言的覆盖菜单、`customVoice` 文本框（优先级最高）、`rate` / `pitch` / `volume` 菜单，默认 +0% / +0Hz / +0%。
5. 错误映射，Bob 的 error.type 取 `param / network / api / unsupportLanguage / unknown`：握手失败或 403 → api，提示「微软接口拒绝连接，请检查系统时间；若持续失败请更新插件」；收到 turn.end 但无音频 → api，提示「未返回音频，请换个音色重试」；超时 → network；语言不在表内 → unsupportLanguage。所有错误都填 `addtion` 详细信息。
6. `pluginValidate`：用当前音色合成两个字，成功则 `completion({ result: true })`。
7. `pluginTimeoutInterval` 返回 60；每条连接 `timeoutInterval` 30 秒，收不到 turn.end 也要在超时后返回错误，不能挂死；completion 只能调用一次，要做防重。
8. 日志：每次合成 `$log.info` 记录音色、段数、字节数、耗时；不记录用户文本全文。

## 测试（jsc 离线，不联网）

- SHA-256 已知答案；Sec-MS-GEC 两个向量；ticks 字串不出现科学计数法
- 二进制帧解析：构造「2 字节长度 + 头 + 音频」的假帧，含无 Content-Type 无数据的结束帧
- 分段：中英混合长文本切分不破坏 UTF-8 与 XML 实体
- SSML 转义；音色解析优先级 customVoice > 语言覆盖 > 全局 > 内置表
- 用桩 `$websocket` 演练完整状态机：成功、握手 error、超时、只收到 turn.end 没有音频、completion 只触发一次
- `python3 scripts/check_info.py` 校验 info.json 的选项与 JS 里读取的一致

## 完成标准

`make test` 输出 ALL PASS；`make install` 装进 Bob 后中文、英文、日文各朗读一次成功；一段约 500 字的中文能分段合成并连续播放；把系统时间故意调偏 10 分钟仍能通过重签成功，或给出明确错误提示。提交到新分支并推送，开 PR。PR 描述写清微软接口的非官方性质与已知风险：2024-10 加 Sec-MS-GEC 校验、2025-12 加 UA / MUID 校验、2026 年仍有间歇性无音频与 503。不要发布 Release，不要改 appcast 的版本记录。

## 参考

- rany2/edge-tts（LGPL-3.0）：`src/edge_tts/constants.py` 提供 UA、版本号、端点，实现时取 GitHub master 上的最新值写进 config.js 并注明来源版本；`drm.py` 是签名与时钟偏差；`communicate.py` 是帧解析。只参考协议事实，不要复制代码。
- Bob 文档：https://bobtranslate.com/plugin/api/websocket.html 、https://bobtranslate.com/plugin/api/data.html 、https://bobtranslate.com/plugin/api/http.html 、https://bobtranslate.com/plugin/api/log.html ，以及 TTS 插件接口说明。参数名以文档为准，社区插件 akl7777777/bob-plugin-akl-microsoft-free-tts 的 `src/main2.js` 用的是 `header`。
- 同作者插件规范：poyih/bob-plugin-vercel-tts 提供工程结构、Makefile 与 jsc 测试桩写法；poyih/bob-plugin-openai-tts 提供错误处理与音频结构校验思路。
