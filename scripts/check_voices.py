#!/usr/bin/env python3
"""联网核对插件里写死的音色是否还在微软的音色列表里。

微软偶尔会下线音色；内置语言表或菜单里留着不存在的音色，用户选中后只会得到
「音色不存在或已下线」。这个脚本不属于 make test（单测不联网），改音色表后手动跑：

    make voices                      # 核对 config.js 与 info.json
    make voices VOICES_ARGS=--list   # 列出全部音色的 ShortName，方便填「自定义音色」
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

VOICE_RE = re.compile(r"[a-z]{2,3}(?:-[A-Za-z0-9]+)+-[A-Za-z0-9]+Neural")


def js_string(js: str, name: str) -> str:
    match = re.search(r"var\s+" + re.escape(name) + r'\s*=\s*"([^"]*)"', js)
    return match.group(1) if match else ""


def fetch_voices(config_js: str) -> list:
    token = js_string(config_js, "TRUSTED_CLIENT_TOKEN")
    base = js_string(config_js, "BASE_URL")
    major = js_string(config_js, "CHROMIUM_FULL_VERSION").split(".")[0]
    url = f"https://{base}/voices/list?trustedclienttoken={token}"
    request = urllib.request.Request(url, headers={
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            f"Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="列出全部音色后退出")
    args = parser.parse_args()

    config_js = (SRC / "config.js").read_text(encoding="utf-8")
    info = json.loads((SRC / "info.json").read_text(encoding="utf-8"))

    try:
        voices = fetch_voices(config_js)
    except Exception as err:  # 网络问题不该被误报成音色缺失
        print(f"voices FAIL  请求音色列表失败：{err}", file=sys.stderr)
        return 2
    available = {v["ShortName"]: v for v in voices}

    if args.list:
        for name in sorted(available):
            voice = available[name]
            print(f"{name:<40} {voice.get('Gender', ''):<7} {voice.get('Locale', '')}")
        print(f"共 {len(available)} 个音色")
        return 0

    referenced: dict[str, set] = {}
    for lang, voice in re.findall(r'\[\s*"([A-Za-z-]+)",\s*"([^"]+)"\s*\]', config_js):
        referenced.setdefault(voice, set()).add(f"config.js DEFAULT_VOICES[{lang}]")
    default_global = js_string(config_js, "DEFAULT_GLOBAL_VOICE")
    if default_global:
        referenced.setdefault(default_global, set()).add("config.js DEFAULT_GLOBAL_VOICE")
    for option in info.get("options", []):
        if option.get("type") != "menu":
            continue
        for item in option.get("menuValues", []):
            value = str(item.get("value"))
            if VOICE_RE.fullmatch(value):
                referenced.setdefault(value, set()).add(f"info.json {option.get('identifier')}")

    missing = sorted(name for name in referenced if name not in available)
    for name in missing:
        print(f"voices FAIL  {name} 已不在音色列表里，出现于：{', '.join(sorted(referenced[name]))}")
    if missing:
        return 1
    print(f"voices ok    插件引用的 {len(referenced)} 个音色都在微软的音色列表里（列表共 {len(available)} 个）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
