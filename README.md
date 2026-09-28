# Microsoft Edge 语音合成 · Bob 插件

给 [Bob](https://bobtranslate.com) 用的 TTS 插件，调用 Edge 浏览器「大声朗读」背后的语音合成接口。不需要 API Key，不需要注册 Azure，国内直连。音色是微软的神经网络语音，晓晓、云希、Aria、七海都在，覆盖近 80 种语言。

> [!WARNING]
> 这是 Edge 浏览器的内部接口，不是公开 API，微软每隔几个月会收紧一次校验，插件随时可能失效。要稳定可靠，请用 Bob 内置的「Microsoft 语音合成」并自备 Azure 密钥。详见[已知限制](#已知限制)。

## 特点

- **按语言自动选音色**：内置 79 种语言的默认音色。简中、繁中、粤语、英、日、韩有单独的菜单，其他语言可以在「按语言指定音色」里写 `fr=fr-FR-HenriNeural` 这样的映射，也可以让一个 Multilingual 音色读所有语言。
- **长文本自动分段**：按 3000 字节尽量在换行或句末标点处切开，逐段合成后拼成一段 mp3。
- **系统时间不准也能用**：握手被拒时自动向微软取服务器时间，校准后重新签名再试。
- **遇到故障自己兜底**：服务端 5xx、中途断开、连上后没数据时换一条连接再试，整次朗读最多两次；选的音色读不了当前语言时自动改用该语言的默认音色。
- **断网不会卡住**：握手 10 秒没完成、连上后 15 秒收不到数据都有看门狗，整次朗读 55 秒内必有结果。各种失败都有明确提示，见[常见报错](#常见报错)。

## 安装

从 [Releases](https://github.com/poyih/bob-plugin-edge-tts/releases) 下载 `.bobplugin` 双击安装，或者克隆仓库后 `make install`。需要 Bob 1.8.0 或更高版本。

在 Bob「偏好设置 → 服务 → 语音合成」点加号，添加「Microsoft Edge 语音合成」，不用填任何东西。点「验证」时插件会用当前音色真实合成两个字。

## 设置项

| 选项 | 说明 |
|---|---|
| 音色模式 | 「按语言自动」（默认）：每种语言用各自的默认音色；「全局固定」：所有语言都用全局音色 |
| 全局音色 | 仅在全局固定时生效，建议选 Multilingual 系列 |
| 简中 / 繁中 / 粤语 / 英语 / 日语 / 韩语音色 | 朗读对应语言时使用，全局固定也盖不过它。六个菜单会同时显示，插件只读当前语言的那一个 |
| 按语言指定音色 | 给没有单独菜单的语言固定音色，格式 `语言码=音色`，多条用分号隔开，如 `fr=fr-FR-HenriNeural; de=de-DE-ConradNeural`。语言码用 Bob 的写法，不区分大小写 |
| 自定义音色 | 填音色的 ShortName（如 `fr-FR-HenriNeural`），填了就对所有语言生效 |
| 语速 / 音调 / 音量 | 语速 -50% 到 +100%，音调 -50Hz 到 +50Hz，音量是相对音色默认音量的增减 |

音色优先级：自定义音色 > 当前语言的菜单 > 按语言指定 > 全局音色 > 内置默认音色。选中的音色读不了当前语言（例如用英文音色读中文）时，插件会自动改用该语言的内置默认音色再合成一次，日志里会记一行。

## 音色

普通音色只能读自己的语言（中日韩音色还能读英文），读别的语言时微软不返回音频，插件会改用该语言的默认音色重试；本来就是默认音色的话才提示「未返回音频」。Multilingual 系列能读中、英、日、韩、法、德、西、俄、阿拉伯、印地、泰、越等语言，适合做全局音色。

默认音色：简中晓晓、繁中曉臻、粤语曉曼、英语 Aria、日语七海、韩语 SunHi，其余语言见 [`src/config.js`](src/config.js)。微软的全部 300 多个音色可以用 [edge-tts](https://github.com/rany2/edge-tts) 列出 ShortName（需先装 [uv](https://docs.astral.sh/uv/)）：

```bash
uvx edge-tts --list-voices
```

## 常见报错

| 提示 | 原因 |
|---|---|
| 微软接口拒绝连接 | 自动校准时钟后仍被拒，多半是微软又改了校验，见[接口失效时](#接口失效时) |
| 未返回音频 | 音色读不了这种语言且没有可改用的默认音色，或微软偶发不给音频；插件已重试过一次 |
| 音色 xxx 不存在或已下线 / 音色名称格式无效 | 音色名写错了，或微软下线了这个音色 |
| 连接不上微软语音服务 | 断网、代理不通或域名解析失败 |
| 与微软语音服务的连接中断 / 微软接口中途关闭了连接 | 合成途中网络断开或服务端断开，插件已自动重试两次仍失败，稍后再试 |
| 连接微软语音服务超时 | 一直在收数据，但 30 秒内没合成完 |
| 文本较长，55 秒内没有合成完 | 超出单次朗读的时间预算，分几次朗读 |

排查时看 Bob 日志。每次合成写一行 `done` 或 `failed`，带音色、段数、重试次数、字节数和耗时，不记录朗读的文本：

```bash
grep -rh 'edge-tts' ~/Library/Containers/com.hezongyidev.Bob/Data/Documents/MMKitLogs/MMLogs/Default/ | tail -20
```

Bob 报「获取音频失败」而日志里没有 `edge-tts`，说明 Bob 识别出的语种不在插件支持的列表里，插件没有被调用。

## 已知限制

- **非官方接口，随时可能变**：近两年微软先后加了签名校验、换了端点、开始校验 User-Agent，2026 年仍有间歇性无音频和 503 的报告。历次变更见 [docs/feasibility.md](docs/feasibility.md#风险时间线)。
- **只有一种音频格式**：24 kHz、48 kbps、单声道 mp3。
- **没有情感风格和多角色**：接口只接受 Edge 自己会发的 SSML，Azure 的 `express-as` 用不了。
- **文本会发给微软**：朗读内容经 WebSocket 发到 `speech.platform.bing.com`，不要用它读敏感内容。
- **云服务器 IP 可能被限流**：家用宽带正常。

## 免责声明

本插件与微软无关。它调用的是 Edge 浏览器的内部接口，使用前请自行判断是否符合微软的服务条款。不保证可用性，不适合商业用途。

## 接口失效时

先用 edge-tts 确认是不是接口本身的问题：

```bash
uvx edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好" --write-media /tmp/edge.mp3
```

edge-tts 也失败，说明微软改了校验：等上游修复后运行 `make upstream`，它会把上游 `src/edge_tts/constants.py` 里的浏览器版本号、端点和握手头与 `src/config.js` 逐项对照，把列出来的不一致项改掉即可，协议常量都集中在这一个文件里。仓库的定时任务每周一也会自动对照一次并核对音色列表，有出入就开一个带 `upstream-drift` 标签的 issue。GitHub 会停用 60 天没有提交的仓库的定时任务，需要到 Actions 页手动重新启用。

edge-tts 正常而插件失败，用联网冒烟测试宿主看插件卡在哪一步：

```bash
swiftc -O scripts/live/harness.swift -o /tmp/edge-harness
/tmp/edge-harness src --text "你好，世界" --lang zh-Hans --out /tmp/out.mp3
# 其他参数：--validate、--clock-offset 600（模拟本机时钟快 10 分钟）、--text-file 文件、--option 键=值
```

宿主用系统的 JavaScriptCore 加载 `src/`，把 `$websocket`、`$http`、`$timer` 接到真实网络上。它的 WebSocket 客户端与 Bob 的不同，能验证协议实现，不能代替在 Bob 里实测。

## 开发

插件逻辑在 `src/main.js`，协议常量和音色表在 `src/config.js`，SHA-256 在 `src/sha256.js`，文本清理与分段在 `src/text.js`。

还没在 Bob 里真机验证过的事项，以及只能在真机上评估的改进（分段并发、HEAD 校时），见 [docs/tasks/03-verify-on-device.md](docs/tasks/03-verify-on-device.md)，可以直接作为一次本地 Claude Code 会话的第一条消息。

```bash
make test       # 语法检查 + info.json 校验 + 离线单测（macOS 用 Bob 同款 JavaScriptCore，其他系统自动改用 Node，以 jsc 为准）
make voices     # 联网核对内置音色是否还在微软的音色列表里
make upstream   # 联网对照上游 edge-tts 的协议常量，看 config.js 有没有落后
make pack       # 打包到 dist/，并打印 sha256
make install    # 打包并交给 Bob 安装
```

发版：改 `src/info.json` 的 `version` 并合并到 main，然后打带注释的标签并推送：

```bash
git tag -a v1.1.0 -m "更新说明" && git push origin v1.1.0
```

Release 工作流会 `make pack`、创建 `v1.1.0` Release 并上传 `dist/*.bobplugin`，再把 sha256 和下载地址登记进 `appcast.json` 推回 main；标签注释的第一行是 appcast 里的更新说明，全文是 Release 说明。推不了 main 时它会推到 `appcast/v1.1.0` 分支并尝试开 PR。不方便在本地推标签时，也可以在 Actions 页手动运行 Release 工作流并填写更新说明，它会按 `src/info.json` 的版本自己打标签再发版。手动发版仍可按 `make pack` → 创建 Release 上传 `dist/*.bobplugin` → `make appcast DESC="更新说明"` → 提交 `appcast.json` 的顺序做，Release 资产上传之前不要登记 appcast。

Bob 运行时与文档有几处出入：握手头要放在单数的 `header` 里，`$data` 没有 `length`，关闭连接要写 `close({})`，连接失败时没有任何回调，`timeoutInterval` 不起作用。实测记录见 [docs/poc-findings.md](docs/poc-findings.md)。

## 参考

- [rany2/edge-tts](https://github.com/rany2/edge-tts)：协议的参考实现。本插件只参考协议事实，没有复制其代码
- Bob 插件文档：[语音合成](https://bobtranslate.com/plugin/quickstart/tts.html) · [WebSocket](https://bobtranslate.com/plugin/api/websocket.html)

## License

[MIT](LICENSE)
