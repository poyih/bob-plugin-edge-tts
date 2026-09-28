# 任务卡 3：真机验证 1.1.0 的兜底逻辑，评估分段并发与 HEAD 校时

> 用法：在装有 Bob 的 Mac 上克隆仓库（已有就 `git pull`），在该目录新开一个 Claude Code 会话，把本文件全文作为第一条消息贴进去；或者自己按步骤手动执行。预计 1 到 2 小时。需要 Bob 1.8.0 以上（PoC 时用的是 1.21.0）、Xcode 命令行工具（编译 `scripts/live/harness.swift`），以及 [uv](https://docs.astral.sh/uv/)（用 edge-tts 做对照，可选）。
>
> ```bash
> git clone https://github.com/poyih/bob-plugin-edge-tts.git
> cd bob-plugin-edge-tts && claude
> ```

## 背景

1.1.0（PR #5）给插件加了三样东西：瞬时故障自动重试、音色读不了当前语言时回退到该语言的默认音色、「按语言指定音色」文本项。这些逻辑只在 `scripts/test_plugin.js` 的离线桩上验证过，没有在 Bob 里真机跑过。另外有两项改进在云端沙箱里做不了，因为沙箱访问不了 `speech.platform.bing.com`，也没有 Bob 运行时：

1. 长文本分段目前是**串行**逐段合成，想改成 2 到 3 路并发，但不知道微软会不会限流。
2. 握手被拒后的校时探测用 GET 下载整份音色列表（322 个音色的 JSON）只为读一个 `Date` 头，想改成 HEAD，但不知道 Bob 的 `$http.request` 支不支持 HEAD。

这张卡的第 1 步是必做的验证，第 2、3 步是评估，测通了就实现，测不通就把结论写进文档。

Bob 运行时的几处特殊之处先记住，都是 `docs/poc-findings.md` 里的实测结论：`$websocket.new` 的握手头要放在单数的 `header` 里；连接被拒、域名解析失败、TCP 被掐断、握手后服务端沉默这四种情况 Bob **不给任何回调**，插件靠自己的 `$timer` 看门狗；`$data` 没有 `length`，取字节用 `toByteArray()`；关闭连接要写 `close({})`；`$http` 的响应头键名区分大小写（`headers.Date` 有值，`headers.date` 是 `undefined`）。

## 第 0 步：确认接口可用，装上当前版本（5 分钟）

```bash
uvx edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好，世界" --write-media /tmp/edge.mp3 && afplay /tmp/edge.mp3
make test && make install
```

edge-tts 失败说明微软侧当前不可用，先跑 `make upstream` 看上游有没有改常量，把结果记下来后停止。`make install` 会打包并交给 Bob 安装，之后在 Bob「偏好设置 → 服务 → 语音合成」里确认「Microsoft Edge 语音合成」已是 1.1.0。

顺手跑一次 `make voices`：1.1.0 往全局音色菜单加的 `fr-FR-HenriNeural`、`de-DE-ConradNeural`、`es-ES-AlvaroNeural`、`ru-RU-DmitryNeural` 是在沙箱里凭记忆写的，没联网核对过。缺哪个就从 `src/info.json` 的 `globalVoice` 菜单里删掉。

日志看这里，每次合成一行 `done` 或 `failed`：

```bash
grep -rh 'edge-tts' ~/Library/Containers/com.hezongyidev.Bob/Data/Documents/MMKitLogs/MMLogs/Default/ | tail -20
```

## 第 1 步：真机验证 1.1.0 的兜底逻辑（必做，20 分钟）

逐项在 Bob 里操作，对照日志：

| 操作 | 期望 |
|---|---|
| 音色模式改「全局固定」，全局音色选 Aria（`en-US-AriaNeural`），朗读一段中文 | 听到的是晓晓；日志有 `改用默认音色 zh-CN-XiaoxiaoNeural` 和 `done voice=zh-CN-XiaoxiaoNeural(fallback) ... retries=1` |
| 同样设置朗读一段英文 | Aria 直接读，`retries=0` |
| 改回「按语言自动」，「按语言指定音色」填 `fr=fr-FR-HenriNeural; de=de-DE-ConradNeural`，朗读一段法语、一段德语 | 分别是 Henri 和 Conrad；日志 `voice=fr-FR-HenriNeural(map)` |
| 看一眼「按语言指定音色」这个文本框 | 选项里写了 `textConfig.height: 60`，如果 Bob 认这个键它是多行的；不认就是普通单行框，把结论记下来，不认的话从 `src/info.json` 里删掉这个键 |
| 朗读一段 3000 字节以上、含 `1.`/`2.` 编号行的中文列表 | 日志 `segments` 大于 1，听起来编号没有被读到上一段末尾 |
| 点「验证」 | 通过；把全局音色改成 Aria 再点，也应通过（验证用的是 Hi） |
| 断开 Wi-Fi 朗读 | 10 秒内报「连接不上微软语音服务」，Bob 不卡死 |

第一行最重要：它证明 Bob 在第一条连接结束后能马上建第二条连接并成功，这是重试和回退共同依赖的前提。

想真正制造 1011 关闭、断流这类瞬时故障，可以用 `poc/edge-tts-websocket` 分支上的 `scripts/poc/probe_server.py` 扮演故障服务端（见该分支 `docs/poc-findings.md` 第 6 节和第 10 节），把 `src/config.js` 的 `WSS_URL` 临时改成探针地址后 `make install`。这一项可选，做了记得改回来。

有任何一项不符合期望，先修，修完再往下走。

## 第 2 步：评估分段并发合成（40 分钟）

### 2.1 基线

准备一段约 2000 字的中文（会切成 3 段左右）存成文件，用联网冒烟宿主测 3 次：

```bash
swiftc -O scripts/live/harness.swift -o /tmp/edge-harness
/tmp/edge-harness src --text-file /path/to/long.txt --lang zh-Hans --out /tmp/long.mp3
```

记下每次 `done ... segments=N ms=...` 的总耗时。在 Bob 里也朗读一次同样的文本，看日志里的耗时。

### 2.2 实验

开一个实验分支，在 `src/main.js` 的 `synthesize()` 里把串行的 `next()` 改成最多 `N` 段同时在途：

- `connectOnce` 已经把每段的音频帧作为 `audio.frames` 整体交回，可以先按段号缓存，全部完成后再按顺序喂给 `Base64Sink`，音频顺序就不会乱。
- 每段各自走 `synthesizeSegment` 的重试和回退逻辑；`job.transientRetries`、`job.noAudioRetried`、`job.skewProbed` 是整次朗读共用的计数，并发时也共用，JavaScriptCore 单线程，不需要加锁。
- 任何一段最终失败就整体报错，而且只报一次；其他在途的连接要被关掉，可以给 `connectOnce` 加一个返回值 `cancel()`，内部调 `finish({ kind: "cancelled" })`，被取消的段的回调直接忽略。
- 预算 `job.deadline` 和每条连接的 `timeoutSeconds` 逻辑保持不变。
- `completion` 只能回调一次，`activeSockets` 里的连接结束后都要清掉，这两点 `scripts/test_plugin.js` 第 14、16、27 组用例有现成的检查方式。

分别用 `N = 2` 和 `N = 3`，在家宽和手机热点下各跑 5 次以上，观察：握手有没有 403 / 429；有没有 1011 关闭或无音频；单条连接的吞吐有没有下降；总耗时比基线省多少。**也要在 Bob 里跑**，宿主用的是 URLSession 的 WebSocket，Bob 用的是 Starscream，多条并发连接的行为可能不同。

### 2.3 决定

- 稳定且 3 段以上的文本总耗时至少省三成：正式实现，默认 2 路，写成 `src/config.js` 里的一个常量，不新增用户选项；`scripts/test_plugin.js` 补用例（桩 `$websocket` 按 `new` 的顺序取脚本，天然支持多条连接，参照第 27 组「两次朗读互不干扰」的写法），覆盖成功、中间一段失败、预算用尽三种情况。
- 出现限流或不稳定：不实现，在 `docs/poc-findings.md` 末尾加一节「分段并发」，写清实验条件、次数和现象，说明为什么保持串行。

## 第 3 步：校时探测改用 HEAD（20 分钟）

先在 Bob 外面看微软接受不接受 HEAD：

```bash
curl -sI -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0" \
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4" | head -20
```

要的是 200 加 `Date` 头；405 或没有 `Date` 就到此为止。

再看 Bob 的 `$http.request` 支不支持 `method: "HEAD"`：在 `src/main.js` 的 `probeClockSkew()` 里临时把 `method` 改成 HEAD，加一行日志打出 `resp.response.statusCode` 和 `findHeader(response.headers, "date")`，`make install` 后把系统时间调快 10 分钟朗读一次触发校时（或者把 `src/config.js` 的 `GEC_WINDOW_SECONDS` 临时改错让握手必被拒）。

- 两边都支持：`probeClockSkew()` 改成先 HEAD，失败或没有 `Date` 头时回退 GET；`SKEW_PROBE_TIMEOUT` 不变。`scripts/test_plugin.js` 第 18 组用例里断言一下 `httpRequests[0].method === "HEAD"`，再补一个 HEAD 出错后回退 GET 的用例。
- 任一边不支持：在 `probeClockSkew()` 的注释里写明原因，`docs/poc-findings.md` 第 7 节补一行结论。

记得把临时日志和临时改动清掉。

## 第 4 步：收尾

- `make test` 全部通过，`make voices` 通过，`make upstream` 通过。
- README：第 1 步里发现的与文档不符之处、第 2 步若实现了并发，都要同步；`docs/poc-findings.md` 按上面说的补结论。
- 若 1.1.0 还没打 tag，这些改动可以并入 1.1.0；已经发了就把 `src/info.json` 的 `version` 升到 1.2.0。发版流程见 README「开发」一节。
- 顺手把 GitHub 仓库简介里的「覆盖 83 种语言」改成「覆盖近 80 种语言」（仓库页右上角的设置齿轮，或 `gh repo edit --description`）。
- 提交到新分支并推送，开 PR。PR 描述里写清每一步的实测数据。

## 参考

- `docs/poc-findings.md`：Bob 运行时的实测行为、故障时的回调、`$http` 读响应头。
- README「接口失效时」：联网冒烟宿主 `scripts/live/harness.swift` 的用法与参数。
- `scripts/test_plugin.js`：离线桩的写法，新逻辑都要在这里补用例。
- `poc/edge-tts-websocket` 分支：PoC 插件、探针服务端 `scripts/poc/probe_server.py` 与原始日志。
