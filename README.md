# Microsoft Edge 语音合成 · Bob 插件

给 [Bob](https://bobtranslate.com) 用的 TTS 插件，调用 Edge 浏览器「大声朗读」背后的语音合成接口。不需要 API Key，不需要注册 Azure，国内直连。音色是微软的神经网络语音，晓晓、云希、Aria、七海都在，覆盖 80 多种语言。

> 这是 Edge 浏览器的内部接口，不是公开 API。微软每隔几个月会收紧一次校验，插件随时可能失效，失效后需要等更新。要稳定可靠请用 Bob 内置的「Microsoft 语音合成」并自备 Azure 密钥。详见[已知限制](#已知限制)与[免责声明](#免责声明)。

## 特点

**免 Key。** 装上就能用，没有额度，没有账单。

**按语言自动选音色。** 内置 83 种 Bob 语言到默认音色的对照表，朗读什么语言就用什么音色。简中、繁中、粤语、英语、日语、韩语各有一个菜单可以单独指定。也可以切到「全局固定」，让 Multilingual 系列的一个音色读所有语言。

**长文本自动分段。** 接口单条消息有长度上限，插件按 3000 字节在句末标点处切开，逐段合成后把 mp3 首尾拼接，不会切开多字节字符和 XML 实体。

**系统时间不准也能用。** 接口的签名按 5 分钟取整，本机时钟偏差 10 分钟就会被拒。握手被拒时插件会向微软取一次服务器时间，算出偏差后重新签名再试一次。

**错误不会被吞掉。** 握手被拒、音色不存在、音色读不了这种语言、网络不通、超时，各有各的提示，附加信息里带着连接阶段、帧数和关闭码。

**断网时不会干等。** 连接被拒、域名解析失败、连接中途被掐断，这几种情况 Bob 不给插件任何回调。插件自带看门狗：握手 10 秒没完成、或者连上之后 15 秒没收到数据，就直接报错。

**可测试。** `make test` 用 macOS 自带的 jsc 跑 280 多个离线用例，jsc 就是 Bob 跑插件的那个 JavaScriptCore。另有一个联网的冒烟测试宿主，接口疑似失效时用它一分钟内就能确认。

## 安装

从 [Releases](https://github.com/poyih/bob-plugin-edge-tts/releases) 下载 `.bobplugin` 双击安装，或者本地构建：

```bash
make install
```

装好后打开 Bob 的「偏好设置 → 服务 → 语音合成」，点加号添加「Microsoft Edge 语音合成」。不用填任何东西。点「验证」时插件会用当前音色真实合成两个字。

需要 Bob 1.8.0 或更高版本。

## 设置项

| 选项 | 说明 |
|---|---|
| 音色模式 | 默认「按语言自动」。「全局固定」时所有语言都用下面的全局音色 |
| 全局音色 | 仅在全局固定时生效。建议选 Multilingual 系列 |
| 简体中文 / 繁体中文 / 粤语 / 英语 / 日语 / 韩语音色 | 六个语言各一个菜单，选了具体音色就以它为准，全局固定也盖不过它。Bob 的设置项是静态显示的，六个菜单会同时出现，插件只读当前朗读语言的那一个 |
| 自定义音色 | 填了就优先生效，所有语言都用它。填音色的 ShortName，例如 `fr-FR-HenriNeural` |
| 语速 | -50% 到 +100%，默认 +0% |
| 音调 | -50Hz 到 +50Hz，默认 +0Hz |
| 音量 | 相对音色默认音量的增减，播放音量仍由系统决定 |

音色的优先级：自定义音色、当前语言的菜单、全局音色、内置对照表。

## 音色

普通音色只能读自己的语言，中日韩音色还能读英文。让它读别的语言会得到「未返回音频」。Multilingual 系列能读中、英、日、韩、法、德、西、俄、阿拉伯、印地、泰、越等多种语言，适合做全局音色。

常用语言的默认音色：

| 语言 | 默认音色 |
|---|---|
| 简体中文 | zh-CN-XiaoxiaoNeural |
| 繁体中文 | zh-TW-HsiaoChenNeural |
| 粤语 | zh-HK-HiuMaanNeural |
| 英语 | en-US-AriaNeural |
| 日语 | ja-JP-NanamiNeural |
| 韩语 | ko-KR-SunHiNeural |
| 法语 | fr-FR-DeniseNeural |
| 德语 | de-DE-KatjaNeural |
| 西班牙语 | es-ES-ElviraNeural |
| 俄语 | ru-RU-SvetlanaNeural |

完整对照表在 `src/config.js`。微软的全部音色有 300 多个，列出 ShortName：

```bash
make voices VOICES_ARGS=--list
```

## 常见报错

| 提示 | 原因 |
|---|---|
| 微软接口拒绝连接，请检查系统时间；若持续失败请更新插件 | 握手被拒。重签一次之后仍被拒，多半是微软又改了校验，见[接口失效时](#接口失效时) |
| 未返回音频，请换个音色重试 | 当前音色读不了这种语言，例如用英文音色读中文 |
| 音色 xxx 不存在或已下线，请在插件设置里换一个音色 | 音色名写错了，或微软下线了这个音色 |
| 音色名称格式无效 | 自定义音色不是 `zh-CN-XiaoxiaoNeural` 这种形式 |
| 连接不上微软语音服务（握手 10 秒内没有完成） | 连不上服务器：断网、代理不通、域名解析失败 |
| 连接不上微软语音服务，请检查网络或代理设置 | 握手被拒，取服务器时间的请求也失败 |
| 与微软语音服务的连接中断（15 秒没有收到数据） | 合成途中连接断了 |
| 与微软语音服务的连接中断，请检查网络后重试 | 合成途中 Bob 报告了传输错误 |
| 连接微软语音服务超时 | 一直在收数据，但 30 秒内没合成完 |
| 微软接口中途关闭了连接 | 服务端主动断开，稍后重试 |
| 文本较长，55 秒内没有合成完，请分几次朗读 | 超出单次朗读的时间预算 |

排查时看 Bob 日志：

```bash
grep -rh 'edge-tts' ~/Library/Containers/com.hezongyidev.Bob/Data/Documents/MMKitLogs/MMLogs/Default/ | tail -20
```

每次合成成功写一行 `done`，失败写一行 `failed`，带音色、段数、字节数和耗时。日志里不记录朗读的文本。

Bob 会先判断语种，语种不在插件支持的列表里时直接报「获取音频失败」，插件不会被调用，日志里也就没有 `edge-tts` 的记录。

## 已知限制

- **非官方接口，随时可能变。** 微软近两年的收紧记录：

  | 时间 | 变更 |
  |---|---|
  | 2024-10 | 新增 Sec-MS-GEC 签名校验，旧客户端全部 403 |
  | 2025-08 | 更换端点 |
  | 2025-12 | 校验 User-Agent 必须像 Edge，第三方浏览器扩展失效 |
  | 2026 | 仍有间歇性无音频和 503 的报告 |

- **只有一种音频格式。** 24 kHz、48 kbps、单声道 mp3。
- **没有情感风格和多角色。** 这个接口只接受 Edge 自己会发的 SSML，Azure 上的 `express-as` 用不了。
- **文本会发给微软。** 朗读的内容通过 WebSocket 发到 `speech.platform.bing.com`，不要用它读敏感内容。
- **数据中心网络可能被限。** 微软对云服务器的 IP 段有限流，家用宽带正常。

## 免责声明

本插件与微软无关。它调用的是 Edge 浏览器的内部接口，使用前请自行判断是否符合微软的服务条款。不保证可用性，不适合商业用途。

## 接口失效时

先确认是不是接口本身的问题：

```bash
uvx edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好" --write-media /tmp/edge.mp3
```

[edge-tts](https://github.com/rany2/edge-tts) 也失败，说明微软改了校验，等上游修复后把 `src/edge_tts/constants.py` 里的浏览器版本号、请求头和端点同步到 `src/config.js`，协议常量都集中在这一个文件里。edge-tts 正常而插件失败，用联网宿主看插件卡在哪一步：

```bash
swiftc -O scripts/live/harness.swift -o /tmp/edge-harness
/tmp/edge-harness src --text "你好，世界" --lang zh-Hans --out /tmp/out.mp3
/tmp/edge-harness src --validate
/tmp/edge-harness src --text "你好" --clock-offset 600     # 模拟本机时钟快 10 分钟
/tmp/edge-harness src --text-file long.txt --lang zh-Hans   # 长文本分段
/tmp/edge-harness src --text "Bonjour" --lang fr --option customVoice=fr-FR-HenriNeural
```

宿主用系统的 JavaScriptCore 加载 `src/` 下的代码，把 `$websocket`、`$http`、`$timer` 接到真实网络上。它的 WebSocket 客户端与 Bob 的不是同一个，能验证协议实现，不能代替在 Bob 里实测。

## 开发

```bash
make test       # 语法检查 + info.json 校验 + jsc 单测，不联网
make voices     # 联网核对内置音色是否还在微软的音色列表里
make pack       # 打包到 dist/，并打印 sha256
make install    # 打包并交给 Bob 安装
make appcast DESC="更新说明"   # 把 dist/ 里的包登记进 appcast.json
```

发版：改 `src/info.json` 的 `version`，`make pack`，在 GitHub 创建 `v<version>` Release 并上传 `dist/*.bobplugin`，`make appcast DESC="..."`，提交 `appcast.json`。Release 资产存在之前不要登记 appcast。

Bob 运行时的真实行为与文档有几处出入，实测记录在 `docs/poc-findings.md`：握手头要放在单数的 `header` 里，`$data` 没有 `length`，关闭连接要写 `close({})`，连接失败时没有任何回调，`timeoutInterval` 不起作用。

## 结构

```
src/
  info.json   插件元信息与设置项
  main.js     tts / pluginValidate / supportLanguages、签名、分段、帧解析、连接状态机、错误映射
  config.js   协议常量、语言到音色的对照表
  icon.png    插件图标
scripts/
  test_plugin.js     jsc 离线单测，桩掉 $websocket / $data / $http / $timer / $option / $log
  check_info.py      校验 info.json，并核对选项 identifier 与 JS 里读取的一致
  check_voices.py    联网核对音色
  update_appcast.py  打包后登记 appcast.json
  make_icon.py       生成图标
  live/harness.swift 联网冒烟测试宿主
docs/
  feasibility.md     可行性分析
  poc-findings.md    Bob 真机验证结论
  tasks/             两张任务卡
```

## 参考

- [rany2/edge-tts](https://github.com/rany2/edge-tts)：协议的参考实现。本插件只参考协议事实，没有复制其代码
- [Bob 插件文档 · 语音合成](https://bobtranslate.com/plugin/quickstart/tts.html)
- [Bob 插件文档 · WebSocket](https://bobtranslate.com/plugin/api/websocket.html)

## License

MIT
