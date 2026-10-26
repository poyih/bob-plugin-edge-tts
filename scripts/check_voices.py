#!/usr/bin/env python3
"""联网核对插件里写死的音色是否还在微软的音色列表里。

微软偶尔会下线音色；内置语言表或菜单里留着不存在的音色，用户选中后只会得到
「音色不存在或已下线」。这个脚本不属于 make test（单测不联网），改音色表后手动跑：

    make voices                      # 核对 config.js 与 info.json
    make voices VOICES_ARGS=--list   # 列出全部音色的 ShortName，方便填「自定义音色」
"""
import argparse
import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

VOICE_RE = re.compile(r"[a-z]{2,3}(?:-[A-Za-z0-9]+)+-[A-Za-z0-9]+Neural")


def js_string(js: str, name: str) -> str:
    match = re.search(r"var\s+" + re.escape(name) + r'\s*=\s*"([^"]*)"', js)
    return match.group(1) if match else ""


def _cs64_hex(message: bytes, digest: bytes) -> str:
    """v2 的 64 位校验：两种 32 位累加链异或后按小端输出。"""
    mask = 0xFFFFFFFF

    def swap_halves(value):
        value &= mask
        return ((value << 16) | (value >> 16)) & mask

    keys = [int.from_bytes(digest[offset:offset + 4], "little") | 1 for offset in (0, 4)]
    # 每个 8 字节块包含两个小端字；尾部不足一块时补零。
    padded = message + bytes(-len(message) % 8)
    word_factors = ((0xEF0569FB, 0x76F50F34, 0xC3EFEA97),
                    (0xC31713DB, 0x1881CE3C, 0x35BD1EC9))
    swapped_sum = swapped_last = chained_sum = chained = 0
    for offset in range(0, len(padded), 8):
        words = [int.from_bytes(padded[index:index + 4], "little")
                 for index in (offset, offset + 4)]
        for word, key, factors in zip(words, keys, word_factors):
            mixed = swap_halves(swap_halves(word) * factors[0] + word * key)
            mixed = (mixed * factors[1]) & mask
            swapped_last = (swap_halves(mixed) * factors[2] + mixed) & mask
            swapped_sum = (swapped_sum + swapped_last) & mask

        chained = ((chained + words[0]) * keys[0]) & mask
        for factor in (0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83):
            chained = (swap_halves(chained) * factor) & mask
        chained_sum = (chained_sum + chained) & mask
        chained = ((chained + words[1]) * keys[1]) & mask
        for factor in (0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69):
            chained = (swap_halves(chained) * factor) & mask
        chained_sum = (chained_sum + chained) & mask

    checksum = (swapped_last ^ chained, swapped_sum ^ chained_sum)
    return b"".join(word.to_bytes(4, "little") for word in checksum).hex().upper()


def voice_list_url(config_js: str, unix_seconds: float) -> str:
    """接口域名下的音色列表地址，带与插件相同的 v2 签名；与上游 edge-tts 的 list_voices 请求一致。"""
    base = js_string(config_js, "BASE_URL")
    token = js_string(config_js, "TRUSTED_CLIENT_TOKEN")
    version = js_string(config_js, "CHROMIUM_FULL_VERSION")
    if not base or not token or not version:
        raise ValueError("config.js 缺少音色列表请求所需的接口域名、令牌或浏览器版本")

    def integer(name):
        match = re.search(r"\bvar\s+" + re.escape(name) + r"\s*=\s*(\d+)\s*;", config_js)
        if not match:
            raise ValueError(f"config.js 缺少签名常量 {name}")
        return int(match.group(1))

    seconds = math.floor(unix_seconds) + integer("WIN_EPOCH_SECONDS")
    window = integer("GEC_WINDOW_SECONDS")
    if window <= 0:
        raise ValueError("GEC_WINDOW_SECONDS 必须大于 0")
    seconds -= seconds % window
    # 先拼整数 ticks，避免远未来时刻经过浮点乘法后产生精度损失。
    message = ("Copyright (C) Microsoft Corporation. All rights reserved."
               + str(seconds) + "0000000" + token).encode("ascii")
    digest = hashlib.sha256(message).digest()
    signature = _cs64_hex(message, digest) + "-" + digest.hex().upper()
    return "https://" + base + "/voices/list?" + urllib.parse.urlencode({
        "trustedclienttoken": token,
        "Sec-MS-GEC": signature,
        "Sec-MS-GEC-Version": "2-" + version,
    })


def fetch_voices(config_js: str) -> list:
    major = js_string(config_js, "CHROMIUM_FULL_VERSION").split(".")[0]
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            f"Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }

    def fetch(url):
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    url = voice_list_url(config_js, time.time())
    try:
        voices = fetch(url)
    except urllib.error.HTTPError as error:
        if error.code != 403:
            raise
        server_date = (error.headers or {}).get("Date")
        try:
            corrected = voice_list_url(config_js, parsedate_to_datetime(server_date).timestamp())
        except (TypeError, ValueError, AttributeError, OverflowError):
            raise error
        if corrected == url:
            raise
        error.close()
        voices = fetch(corrected)

    # 空列表或响应格式变化属于请求失败，不能误报为所有内置音色都已下线。
    if not isinstance(voices, list) or not voices or any(
        not isinstance(voice, dict) or not isinstance(voice.get("ShortName"), str)
        or not VOICE_RE.fullmatch(voice["ShortName"]) for voice in voices
    ):
        raise ValueError("音色列表为空或响应格式无效")
    return voices


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
