#!/usr/bin/env python3
"""对照实验：在 Bob 之外，用同一台机器、同一条网络，逐项去掉握手头，看微软当前到底校验什么。

Bob 里握手成功只能说明「发出去的请求被接受了」；要把它当成「自定义 UA 确实发出去了」的证据，
得先知道不带 Edge UA 时服务器会不会拒绝。本脚本回答这个前提。

用法（需要 aiohttp）：
    uv run --with aiohttp python scripts/poc/edge_header_matrix.py
"""

import asyncio
import hashlib
import json
import secrets
import time

import aiohttp

TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
FULL_VERSION = "143.0.3650.75"
MAJOR = FULL_VERSION.split(".")[0]
WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
EDGE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    f"Chrome/{MAJOR}.0.0.0 Safari/537.36 Edg/{MAJOR}.0.0.0"
)
CHROME_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    f"Chrome/{MAJOR}.0.0.0 Safari/537.36"
)
SAFARI_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/18.0 Safari/605.1.15"
)
ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"


def gec(skew_seconds=0):
    sec = int(time.time() + skew_seconds) + 11644473600
    sec -= sec % 300
    return hashlib.sha256(f"{sec}0000000{TOKEN}".encode("ascii")).hexdigest().upper()


def date_string():
    return time.strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime())


def full_headers():
    return {
        "User-Agent": EDGE_UA,
        "Origin": ORIGIN,
        "Cookie": f"muid={secrets.token_hex(16).upper()};",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Language": "en-US,en;q=0.9",
    }


def without(headers, *names):
    return {k: v for k, v in headers.items() if k not in names}


async def run_case(name, headers, skew=0):
    url = (
        f"{WSS_URL}?TrustedClientToken={TOKEN}&ConnectionId={secrets.token_hex(16)}"
        f"&Sec-MS-GEC={gec(skew)}&Sec-MS-GEC-Version=1-{FULL_VERSION}"
    )
    skip = [] if "User-Agent" in headers else ["User-Agent"]
    result = {"case": name, "sent_headers": sorted(headers)}
    started = time.time()
    try:
        async with aiohttp.ClientSession(skip_auto_headers=skip) as session:
            async with session.ws_connect(url, headers=headers, compress=0, timeout=20) as ws:
                result["handshake"] = 101
                await ws.send_str(
                    f"X-Timestamp:{date_string()}\r\n"
                    "Content-Type:application/json; charset=utf-8\r\n"
                    "Path:speech.config\r\n\r\n"
                    '{"context":{"synthesis":{"audio":{"metadataoptions":{'
                    '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},'
                    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
                )
                await ws.send_str(
                    f"X-RequestId:{secrets.token_hex(16)}\r\n"
                    "Content-Type:application/ssml+xml\r\n"
                    f"X-Timestamp:{date_string()}Z\r\n"
                    "Path:ssml\r\n\r\n"
                    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
                    "<voice name='zh-CN-XiaoxiaoNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>"
                    "你好，世界</prosody></voice></speak>"
                )
                audio = 0
                frames = []
                turn_end = False
                while True:
                    msg = await asyncio.wait_for(ws.receive(), timeout=20)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        if "Path:turn.end" in msg.data:
                            turn_end = True
                            break
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        n = int.from_bytes(msg.data[:2], "big")
                        audio += len(msg.data) - 2 - n
                        frames.append(len(msg.data))
                    else:
                        result["closed"] = f"{msg.type.name} {msg.data} {msg.extra}"
                        break
                result.update(turn_end=turn_end, audio_bytes=audio, binary_frames=frames)
    except aiohttp.WSServerHandshakeError as exc:
        result["handshake"] = exc.status
        result["error"] = exc.message
        result["server_date"] = exc.headers.get("Date") if exc.headers else None
    except Exception as exc:  # noqa: BLE001 - 对照实验，任何失败都要记下来
        result["handshake"] = None
        result["error"] = repr(exc)
    result["ms"] = int((time.time() - started) * 1000)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    await asyncio.sleep(1.0)


async def main():
    full = full_headers()
    await run_case("完整握手头", full)
    await run_case("去掉 Cookie", without(full, "Cookie"))
    await run_case("去掉 Origin", without(full, "Origin"))
    await run_case("去掉 User-Agent", without(full, "User-Agent"))
    await run_case("UA 换成 Chrome（非 Edge）", dict(full, **{"User-Agent": CHROME_UA}))
    await run_case("UA 换成 Safari", dict(full, **{"User-Agent": SAFARI_UA}))
    await run_case("UA 换成 Bob/CFNetwork 风格", dict(full, **{"User-Agent": "Bob/260 CFNetwork/3860.100.1 Darwin/27.0.0"}))
    await run_case("只带 Edge UA", {"User-Agent": EDGE_UA})
    await run_case("什么自定义头都不带", {})
    await run_case("完整握手头 + 时钟慢 10 分钟", full_headers(), skew=-600)
    await run_case("完整握手头（复测）", full_headers())


if __name__ == "__main__":
    asyncio.run(main())
