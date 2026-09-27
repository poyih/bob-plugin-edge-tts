#!/usr/bin/env python3
"""校验 src/info.json：字段格式、菜单默认值在菜单里、选项 identifier 与 JS 里读取的一致，
以及菜单里的音色、语速等取值和 src/config.js 对得上。

用法：python3 scripts/check_info.py（make lint 会自动跑）
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

IDENTIFIER = "com.poyih.bob.plugin.edge.tts"
NAME = "Microsoft Edge 语音合成"
MIN_BOB_VERSION = (1, 8, 0)

VOICE_RE = re.compile(r"[a-z]{2,3}(?:-[A-Za-z0-9]+)+-[A-Za-z0-9]+Neural")
PERCENT_RE = re.compile(r"[+-]\d{1,3}%")
HERTZ_RE = re.compile(r"[+-]\d{1,3}Hz")


def js_string(js: str, name: str) -> str:
    """取 config.js 里 var NAME = "..." 的字符串值。"""
    match = re.search(r"var\s+" + re.escape(name) + r'\s*=\s*"([^"]*)"', js)
    return match.group(1) if match else ""


def version_tuple(value: str) -> tuple:
    return tuple(int(part) if part.isdigit() else 0 for part in str(value).split("."))


def main() -> int:
    info = json.loads((SRC / "info.json").read_text(encoding="utf-8"))
    main_js = (SRC / "main.js").read_text(encoding="utf-8")
    config_js = (SRC / "config.js").read_text(encoding="utf-8")
    problems: list[str] = []

    for field in ("identifier", "version", "category", "name", "options"):
        if field not in info:
            problems.append(f"缺少必填字段 {field}")
    if not re.fullmatch(r"[a-z0-9.]+", str(info.get("identifier", ""))):
        problems.append("identifier 只能由小写字母、数字和 . 组成")
    if info.get("identifier") != IDENTIFIER:
        problems.append(f"identifier 应为 {IDENTIFIER}")
    if info.get("name") != NAME:
        problems.append(f"name 应为 {NAME}")
    if not re.fullmatch(r"[a-z0-9.]+", str(info.get("version", ""))):
        problems.append("version 只能由小写字母、数字和 . 组成")
    if info.get("category") != "tts":
        problems.append("category 必须是 tts")
    if version_tuple(info.get("minBobVersion", "0")) < MIN_BOB_VERSION:
        problems.append("minBobVersion 不能低于 1.8.0（$websocket 需要 1.6.0，textConfig 需要 1.8.0）")
    icon = info.get("icon")
    if icon and not (SRC / icon).is_file():
        problems.append(f"icon {icon} 不存在于 src/")

    appcast_path = ROOT / "appcast.json"
    if appcast_path.is_file():
        appcast = json.loads(appcast_path.read_text(encoding="utf-8"))
        if appcast.get("identifier") != info.get("identifier"):
            problems.append("appcast.json 的 identifier 与 info.json 不一致")

    options = info.get("options", [])
    ids = [o.get("identifier", "") for o in options]
    by_id = {o.get("identifier", ""): o for o in options}
    if len(ids) != len(set(ids)):
        problems.append("options 里有重复的 identifier")

    for option in options:
        ident = option.get("identifier", "?")
        for field in ("identifier", "type", "title"):
            if field not in option:
                problems.append(f"{ident}: 缺少 {field}")
        kind = option.get("type")
        if kind == "menu":
            values = [m.get("value") for m in option.get("menuValues", [])]
            if not values:
                problems.append(f"{ident}: menu 没有 menuValues")
            if len(values) != len(set(values)):
                problems.append(f"{ident}: 菜单值重复")
            if option.get("defaultValue") not in values:
                problems.append(f"{ident}: defaultValue {option.get('defaultValue')!r} 不在菜单里")
            for item in option.get("menuValues", []):
                if not isinstance(item.get("value"), str) or "title" not in item:
                    problems.append(f"{ident}: 菜单项必须有字符串 value 和 title")
        elif kind == "text":
            if "defaultValue" not in option:
                problems.append(f"{ident}: text 选项缺少 defaultValue（Bob 会把它显示成空）")
            text_type = (option.get("textConfig") or {}).get("type")
            if text_type not in (None, "secure", "visible"):
                problems.append(f"{ident}: textConfig.type 只能是 secure / visible")
        else:
            problems.append(f"{ident}: 未知类型 {kind!r}")

    # 选项 identifier 与 JS 里读取的一致
    used = set(re.findall(r'readOption\("([A-Za-z0-9_]+)"\)', main_js))
    used |= set(re.findall(r'pickProsody\("([A-Za-z0-9_]+)"', main_js))
    overrides = re.findall(r'\{\s*lang:\s*"([^"]+)",\s*option:\s*"([A-Za-z0-9_]+)"\s*\}', config_js)
    used |= {option for _, option in overrides}
    for name in sorted(used - set(ids)):
        problems.append(f"JS 读取了 info.json 里不存在的选项 {name}")
    for name in sorted(set(ids) - used):
        problems.append(f"info.json 的选项 {name} 在 JS 里从未被读取")

    # 内置语言表
    table = re.findall(r'\[\s*"([A-Za-z-]+)",\s*"([^"]+)"\s*\]', config_js)
    langs = [lang for lang, _ in table]
    if len(table) < 30:
        problems.append(f"config.js 的 DEFAULT_VOICES 只解析出 {len(table)} 项，格式可能变了")
    if len(langs) != len(set(langs)):
        problems.append("DEFAULT_VOICES 里有重复的语言代码")
    for lang, voice in table:
        if not VOICE_RE.fullmatch(voice):
            problems.append(f"DEFAULT_VOICES: {lang} 的音色 {voice!r} 不像合法的 ShortName")
    required = {
        "zh-Hans": "zh-CN-XiaoxiaoNeural",
        "zh-Hant": "zh-TW-HsiaoChenNeural",
        "yue": "zh-HK-HiuMaanNeural",
        "en": "en-US-AriaNeural",
        "ja": "ja-JP-NanamiNeural",
        "ko": "ko-KR-SunHiNeural",
    }
    mapping = dict(table)
    for lang, voice in required.items():
        if mapping.get(lang) != voice:
            problems.append(f"DEFAULT_VOICES: {lang} 应为 {voice}，实际是 {mapping.get(lang)!r}")

    # 音色模式与全局音色
    follow = js_string(config_js, "FOLLOW_MODE")
    mode = by_id.get("voiceMode", {})
    mode_values = {m.get("value") for m in mode.get("menuValues", [])}
    expected_modes = {js_string(config_js, "VOICE_MODE_AUTO"), js_string(config_js, "VOICE_MODE_GLOBAL")}
    if mode_values != expected_modes:
        problems.append(f"voiceMode 的取值 {sorted(mode_values)} 与 config.js 的 {sorted(expected_modes)} 不一致")
    if mode.get("defaultValue") != js_string(config_js, "VOICE_MODE_AUTO"):
        problems.append("voiceMode 的默认值应为按语言自动")

    global_voice = by_id.get("globalVoice", {})
    if global_voice.get("defaultValue") != js_string(config_js, "DEFAULT_GLOBAL_VOICE"):
        problems.append("globalVoice 的默认值与 config.js 的 DEFAULT_GLOBAL_VOICE 不一致")
    for item in global_voice.get("menuValues", []):
        if not VOICE_RE.fullmatch(str(item.get("value"))):
            problems.append(f"globalVoice: {item.get('value')!r} 不像合法的 ShortName")

    # 六个语言覆盖菜单
    if len(overrides) != 6:
        problems.append(f"LANGUAGE_OVERRIDES 应有 6 项，实际解析出 {len(overrides)} 项")
    for lang, ident in overrides:
        if lang not in mapping:
            problems.append(f"LANGUAGE_OVERRIDES: {lang} 不在 DEFAULT_VOICES 里")
        option = by_id.get(ident)
        if not option:
            continue
        if option.get("type") != "menu":
            problems.append(f"{ident}: 语言覆盖必须是 menu")
            continue
        if option.get("defaultValue") != follow:
            problems.append(f"{ident}: 默认值必须是「不单独指定」（{follow}），否则全局固定模式对这种语言不起作用")
        values = [m.get("value") for m in option.get("menuValues", [])]
        if mapping.get(lang) not in values:
            problems.append(f"{ident}: 菜单里没有这种语言的默认音色 {mapping.get(lang)}")
        for value in values:
            if value != follow and not VOICE_RE.fullmatch(str(value)):
                problems.append(f"{ident}: {value!r} 不像合法的 ShortName")

    # 语速 / 音调 / 音量
    for ident, pattern, const in (
        ("rate", PERCENT_RE, "DEFAULT_RATE"),
        ("pitch", HERTZ_RE, "DEFAULT_PITCH"),
        ("volume", PERCENT_RE, "DEFAULT_VOLUME"),
    ):
        option = by_id.get(ident, {})
        if option.get("defaultValue") != js_string(config_js, const):
            problems.append(f"{ident}: 默认值应与 config.js 的 {const} 一致")
        for item in option.get("menuValues", []):
            if not pattern.fullmatch(str(item.get("value"))):
                problems.append(f"{ident}: {item.get('value')!r} 格式不对")

    if problems:
        for line in problems:
            print("info FAIL  " + line)
        return 1
    print(f"info ok    src/info.json ({len(ids)} options, {len(table)} languages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
