# PoC 原始证据

`docs/poc-findings.md` 里的结论都来自这里的日志。采集于 2026-09-27，Bob 1.21.0 (260)。

| 文件 | 内容 |
|---|---|
| `header-matrix.jsonl` | 在 Bob 之外逐项去掉握手头的对照实验，每行一个用例 |
| `probe-bob.log` | 本机探针抓到的 Bob 握手请求与两条文本消息，连了三次 |
| `bob-run-01-zh.txt` | Bob 里朗读「你好，世界」的逐帧日志 |
| `bob-run-02-en.txt` | Bob 里朗读一句英文的逐帧日志 |
| `bob-run-05-probe.txt` | Bob 连本机探针的三次会话，对应 `probe-bob.log` |
| `bob-run-06-diag.txt` | 诊断模式，录到第 5 步为止 |

`bob-run-*.txt` 是从 Bob 日志里筛出的相关行，`[edge-poc]` 前缀已去掉。方括号开头的行是 Bob 自己打的日志。
