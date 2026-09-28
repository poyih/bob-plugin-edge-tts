#!/usr/bin/env python3
"""对照上游 rany2/edge-tts 的协议常量，检查本插件有没有落后。

微软每隔几个月就收紧一次 Edge「大声朗读」接口的校验（浏览器版本号、端点、握手头），
上游 edge-tts 一般几天内跟进，新值都写在它的 src/edge_tts/constants.py 里。这个脚本把该文件
拉下来，与 src/config.js 的常量和 src/main.js 里 buildHeaders() 发出的握手头逐项比对，
有出入就说明该更新插件了。只用标准库；上游文件用 ast 读字面量，不执行它的代码。

用法：
    make upstream                                          # 联网对照
    python3 scripts/check_upstream.py --report out.md      # 顺便写一份 Markdown 报告（定时任务拿它开 issue）
    python3 scripts/check_upstream.py --upstream-file constants.py [--version-file version.py]
                                                           # 用本地文件对照，不联网

退出码：0 一致；1 有出入或解析失败；2 拉不到上游文件。
.github/workflows/upstream.yml 每周跑一次，有出入时自动开 issue。
"""
import argparse
import ast
import datetime
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

UPSTREAM_REPO = "rany2/edge-tts"
UPSTREAM_DIR = "src/edge_tts"
RAW_BASE = f"https://raw.githubusercontent.com/{UPSTREAM_REPO}/master/{UPSTREAM_DIR}/"
CONSTANTS_URL = RAW_BASE + "constants.py"
VERSION_URL = RAW_BASE + "version.py"

# config.js 里参与对照的常量，按依赖顺序排列（后面的会引用前面的）
CONFIG_VARIABLES = (
    "TRUSTED_CLIENT_TOKEN", "CHROMIUM_FULL_VERSION", "CHROMIUM_MAJOR_VERSION", "SEC_MS_GEC_VERSION",
    "BASE_URL", "WSS_URL", "VOICE_LIST_URL", "USER_AGENT", "ORIGIN", "ACCEPT_LANGUAGE",
)

DYNAMIC = "（每次连接随机生成）"
MISSING = "（未发送）"


class Unsupported(Exception):
    """表达式超出了这个脚本能安全求值的范围。"""


# ---------------------------------------------------------------- 上游：用 ast 读 Python 字面量

def py_eval(node, env):
    """只求值字面量、f-string、已知变量、字典、+ 拼接、.split() 和下标，其他一律拒绝。"""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(str(py_eval(part, env)) for part in node.values)
    if isinstance(node, ast.FormattedValue):
        if node.conversion != -1 or node.format_spec is not None:
            raise Unsupported("f-string 带格式说明")
        return py_eval(node.value, env)
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        raise Unsupported(f"未知变量 {node.id}")
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return py_eval(node.left, env) + py_eval(node.right, env)
    if isinstance(node, ast.Dict):
        result = {}
        for key, value in zip(node.keys, node.values):
            if key is None:
                raise Unsupported("字典展开")
            result[py_eval(key, env)] = py_eval(value, env)
        return result
    if isinstance(node, ast.Subscript):
        index = node.slice
        if hasattr(ast, "Index") and isinstance(index, ast.Index):  # Python 3.8
            index = index.value
        return py_eval(node.value, env)[py_eval(index, env)]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "split":
        target = py_eval(node.func.value, env)
        args = [py_eval(arg, env) for arg in node.args]
        kwargs = {keyword.arg: py_eval(keyword.value, env) for keyword in node.keywords}
        return str(target).split(*args, **kwargs)
    raise Unsupported(type(node).__name__)


def read_upstream(source: str) -> dict:
    """顺序处理模块级的 NAME = ... 和 NAME.update(OTHER)，看不懂的语句跳过。返回变量表。"""
    env: dict = {}
    for statement in ast.parse(source).body:
        try:
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 \
                    and isinstance(statement.targets[0], ast.Name):
                env[statement.targets[0].id] = py_eval(statement.value, env)
            elif isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                call = statement.value
                func = call.func
                if isinstance(func, ast.Attribute) and func.attr == "update" \
                        and isinstance(func.value, ast.Name) and len(call.args) == 1:
                    target = env.get(func.value.id)
                    extra = py_eval(call.args[0], env)
                    if isinstance(target, dict) and isinstance(extra, dict):
                        target.update(extra)
        except Unsupported:
            continue
    return env


def read_upstream_version(source: str) -> str:
    try:
        return str(read_upstream(source).get("__version__") or "未知")
    except SyntaxError:
        return "未知"


# ---------------------------------------------------------------- 本插件：读 JavaScript 字面量

def js_skip_string(js: str, i: int) -> int:
    """js[i] 是引号，返回这个字符串字面量结束之后的下标。"""
    quote = js[i]
    i += 1
    while i < len(js) and js[i] != quote:
        i += 2 if js[i] == "\\" else 1
    return i + 1


def js_skip_comment(js: str, i: int) -> int:
    """js 在 i 处是 // 或 /* 注释时返回注释之后的下标，否则原样返回 i。"""
    if js.startswith("//", i):
        end = js.find("\n", i)
        return len(js) if end < 0 else end
    if js.startswith("/*", i):
        end = js.find("*/", i + 2)
        return len(js) if end < 0 else end + 2
    return i


def js_scan(js: str, start: int, until_semicolon: bool):
    """从 start 起收集文本（去掉注释、不拆字符串）：until_semicolon 为真时读到语句末尾的分号，
    否则 js[start] 必须是 {，读到配对的 } 为止。找不到结尾返回 None。"""
    out = []
    depth = 0
    i = start
    while i < len(js):
        ch = js[i]
        if ch in "\"'":
            end = js_skip_string(js, i)
            out.append(js[i:end])
            i = end
            continue
        skipped = js_skip_comment(js, i)
        if skipped != i:
            out.append(" ")
            i = skipped
            continue
        if until_semicolon and ch == ";" and depth == 0:
            return "".join(out)
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if not until_semicolon and depth == 0:
                out.append(ch)
                return "".join(out)
        out.append(ch)
        i += 1
    return None


def js_var(js: str, name: str):
    """取 var NAME = 表达式; 里等号右边的文本。"""
    match = re.search(r"\bvar\s+" + re.escape(name) + r"\s*=", js)
    return None if not match else js_scan(js, match.end(), True)


def split_top_level(text: str, separator: str) -> list:
    """按不在字符串和括号里的 separator 切分。"""
    parts = []
    depth = 0
    start = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in "\"'":
            i = js_skip_string(text, i)
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == separator and depth == 0:
            parts.append(text[start:i])
            start = i + 1
        i += 1
    parts.append(text[start:])
    return parts


JS_TOKEN = re.compile(r'"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$.]*)|(\+)|(\S)')


def js_lookup(identifier: str, env: dict) -> str:
    name = identifier[len("config."):] if identifier.startswith("config.") else identifier
    if name in env:
        return str(env[name])
    raise Unsupported(f"未知变量 {identifier}")


def js_eval(expression: str, env: dict) -> str:
    """求值 config.js 风格的表达式：双引号字符串、已知变量（含 config.X）、+ 拼接，
    以及 X.split(".")[0] 这一种取主版本号的写法。"""
    special = re.fullmatch(r'\s*([\w$.]+)\.split\("\."\)\[0\]\s*', expression)
    if special:
        return js_lookup(special.group(1), env).split(".")[0]
    parts = []
    expect_operand = True
    for token in JS_TOKEN.finditer(expression):
        literal, identifier, plus, other = token.groups()
        if plus:
            if expect_operand:
                raise Unsupported("多余的 +")
            expect_operand = True
            continue
        if not expect_operand:
            raise Unsupported("两个操作数之间缺少 +")
        if literal is not None:
            try:
                parts.append(json.loads('"' + literal + '"'))
            except ValueError as err:
                raise Unsupported(f"字符串转义无法解析：{err}") from err
        elif identifier:
            parts.append(js_lookup(identifier, env))
        else:
            raise Unsupported(f"无法求值的记号 {other}")
        expect_operand = False
    if expect_operand:
        raise Unsupported("表达式为空")
    return "".join(parts)


def read_config(config_js: str, problems: list) -> dict:
    env: dict = {}
    for name in CONFIG_VARIABLES:
        expression = js_var(config_js, name)
        if expression is None:
            problems.append(f"src/config.js 里找不到 var {name}")
            continue
        try:
            env[name] = js_eval(expression, env)
        except Unsupported as err:
            problems.append(f"src/config.js 的 {name} 无法求值：{err}")
    return env


def read_plugin_headers(main_js: str, config: dict, problems: list) -> dict:
    """解析 main.js 里 buildHeaders() 返回的对象字面量。值算不出来（比如随机 Cookie）记为 DYNAMIC。"""
    match = re.search(r"function\s+buildHeaders\s*\(\s*\)\s*\{\s*return\s*", main_js)
    literal = js_scan(main_js, match.end(), False) if match and main_js.startswith("{", match.end()) else None
    if not literal:
        problems.append("src/main.js 里找不到 buildHeaders() 返回的对象字面量")
        return {}
    headers: dict = {}
    for entry in split_top_level(literal[1:-1], ","):
        if not entry.strip():
            continue
        key_text, separator, value_text = entry.partition(":")
        if not separator:
            problems.append(f"buildHeaders 里无法解析的项：{entry.strip()}")
            continue
        try:
            key = js_eval(key_text, {})
        except Unsupported:
            problems.append(f"buildHeaders 里无法解析的键：{key_text.strip()}")
            continue
        try:
            headers[key] = js_eval(value_text, config)
        except Unsupported:
            headers[key] = DYNAMIC
    return headers


def config_noted_version(config_js: str) -> str:
    """config.js 注释里记录的「协议常量取自 edge-tts x.y.z」。"""
    match = re.search(r"edge-tts\s+(\d+(?:\.\d+)+)", config_js)
    return match.group(1) if match else ""


# ---------------------------------------------------------------- 对照

def strip_query(url: str) -> str:
    return url.split("?", 1)[0]


def header_skipped(name: str) -> bool:
    """Accept-Encoding 由 WebSocket 客户端自己协商，Sec-WebSocket-* 由 Bob 的客户端生成，插件不填。"""
    lower = name.lower()
    return lower == "accept-encoding" or lower.startswith("sec-websocket-")


def compare_all(config: dict, plugin_headers: dict, upstream: dict, problems: list) -> list:
    rows: list = []

    def add(label, ours, theirs, ok=None, note=""):
        rows.append({"label": label, "ours": str(ours), "theirs": str(theirs),
                     "ok": (ours == theirs) if ok is None else ok, "note": note})

    def upstream_value(name):
        if name not in upstream:
            problems.append(f"上游 constants.py 里找不到 {name}，文件格式可能变了，需要人工对照")
        return upstream.get(name)

    pairs = (
        ("CHROMIUM_FULL_VERSION（浏览器版本号）", "CHROMIUM_FULL_VERSION", "CHROMIUM_FULL_VERSION", None),
        ("TRUSTED_CLIENT_TOKEN", "TRUSTED_CLIENT_TOKEN", "TRUSTED_CLIENT_TOKEN", None),
        ("BASE_URL（接口域名与路径）", "BASE_URL", "BASE_URL", None),
        ("WebSocket 地址", "WSS_URL", "WSS_URL", strip_query),
        ("音色列表地址", "VOICE_LIST_URL", "VOICE_LIST", None),
        ("Sec-MS-GEC-Version", "SEC_MS_GEC_VERSION", "SEC_MS_GEC_VERSION", None),
    )
    for label, ours_name, theirs_name, transform in pairs:
        theirs = upstream_value(theirs_name)
        ours = config.get(ours_name)
        if theirs is None or ours is None:
            continue
        add(label, ours, transform(str(theirs)) if transform else str(theirs))

    merged = upstream_value("WSS_HEADERS")
    if isinstance(merged, dict):
        ours_by_name = {key.lower(): value for key, value in plugin_headers.items()}
        for name, value in merged.items():
            ours = ours_by_name.get(name.lower(), MISSING)
            if header_skipped(name):
                add(f"握手头 {name}", ours, value, ok=True, note="跳过：由 Bob 的 WebSocket 客户端自己处理")
            elif ours == DYNAMIC:
                add(f"握手头 {name}", ours, value, ok=True, note="本插件每次连接随机生成，不比对")
            else:
                add(f"握手头 {name}", ours, str(value))
        theirs_names = {name.lower() for name in merged}
        for name, value in plugin_headers.items():
            if name.lower() not in theirs_names:
                add(f"握手头 {name}", value, "（上游 constants.py 里没有）", ok=True, note="本插件额外发送，不影响对照")
    return rows


# ---------------------------------------------------------------- 输出

def cell(value: str) -> str:
    return "`" + str(value).replace("|", "\\|").replace("`", "'") + "`"


def write_report(path: Path, rows: list, problems: list, upstream_version: str,
                 noted_version: str, fetch_error: str = "") -> None:
    today = datetime.date.today().isoformat()
    lines = ["## 上游协议常量对照", ""]
    if fetch_error:
        lines += [f"{today} 拉取上游 [`{UPSTREAM_DIR}/constants.py`]({CONSTANTS_URL}) 失败：{fetch_error}", ""]
    else:
        intro = (f"{today} 对照 [rany2/edge-tts](https://github.com/{UPSTREAM_REPO}) master 的 "
                 f"[`constants.py`]({CONSTANTS_URL})，上游版本 {upstream_version}")
        if noted_version:
            intro += f"，`src/config.js` 注释记录的是 {noted_version}"
        lines += [intro + "。", "", "| 项目 | 本插件 | 上游 | 结果 |", "|---|---|---|---|"]
        for row in rows:
            status = "**不一致**" if not row["ok"] else (row["note"] or "一致")
            lines.append(f"| {row['label']} | {cell(row['ours'])} | {cell(row['theirs'])} | {status} |")
        lines.append("")
    if problems:
        lines += ["### 解析问题", ""] + [f"- {problem}" for problem in problems] + [""]
    if fetch_error:
        lines.append("稍后重跑，或本地执行 `make upstream`。")
    elif problems or any(not row["ok"] for row in rows):
        lines += [
            "### 处理办法", "",
            "1. 把上游的新值写进 `src/config.js` 对应的常量；握手头有增减时同步改 `src/main.js` 的 `buildHeaders()`。",
            "2. `make test` 通过后用 `make voices` 复核音色，再装进 Bob 真机朗读一次。",
            "3. 改 `src/info.json` 的 `version`，按 README「开发」一节发版。",
            "", "对照方法见 README「接口失效时」。",
        ]
    else:
        lines.append("全部一致，不需要更新。")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "bob-plugin-edge-tts/check_upstream"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upstream-file", help="用本地的 constants.py 对照，不联网")
    parser.add_argument("--version-file", help="本地的 version.py，配合 --upstream-file 使用")
    parser.add_argument("--report", help="把 Markdown 报告写到这个文件")
    args = parser.parse_args()

    config_js = (SRC / "config.js").read_text(encoding="utf-8")
    main_js = (SRC / "main.js").read_text(encoding="utf-8")
    problems: list = []
    config = read_config(config_js, problems)
    plugin_headers = read_plugin_headers(main_js, config, problems)
    noted_version = config_noted_version(config_js)
    report = Path(args.report) if args.report else None

    try:
        if args.upstream_file:
            constants_source = Path(args.upstream_file).read_text(encoding="utf-8")
            version_source = Path(args.version_file).read_text(encoding="utf-8") if args.version_file else ""
        else:
            constants_source = fetch(CONSTANTS_URL)
            try:
                version_source = fetch(VERSION_URL)
            except (urllib.error.URLError, OSError):
                version_source = ""
    except (urllib.error.URLError, OSError) as err:  # 网络问题不该被误报成漂移
        print(f"upstream FAIL  拉取上游 constants.py 失败：{err}", file=sys.stderr)
        if report:
            write_report(report, [], [], "", noted_version, fetch_error=str(err))
        return 2

    try:
        upstream = read_upstream(constants_source)
    except SyntaxError as err:
        problems.append(f"上游 constants.py 不是合法的 Python：{err}")
        upstream = {}
    upstream_version = read_upstream_version(version_source)
    rows = compare_all(config, plugin_headers, upstream, problems)

    for row in rows:
        if row["ok"]:
            print(f"upstream ok    {row['label']} = {row['ours']}" + (f"  [{row['note']}]" if row["note"] else ""))
        else:
            print(f"upstream FAIL  {row['label']}：本插件 {row['ours']}，上游 {row['theirs']}")
    for problem in problems:
        print("upstream FAIL  " + problem)
    if report:
        write_report(report, rows, problems, upstream_version, noted_version)
        print(f"报告已写到 {report}")

    drift = [row for row in rows if not row["ok"]]
    source = "edge-tts master" if upstream_version == "未知" else f"edge-tts {upstream_version}"
    if drift or problems:
        print(f"upstream FAIL  与 {source} 的 constants.py 有 {len(drift)} 项出入、"
              f"{len(problems)} 个解析问题，请更新 src/config.js")
        return 1
    print(f"upstream ok    与 {source} 的 constants.py 一致（{len(rows)} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
