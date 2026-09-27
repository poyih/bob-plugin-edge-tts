#!/usr/bin/env python3
"""本机 WebSocket 探针，配合 poc/main.js 的探针模式使用。只依赖标准库，只监听 127.0.0.1。

做两件事：
1. 把 Bob 的 $websocket 实际写到线路上的握手请求原样记下来，回答「自定义的
   User-Agent / Origin / Cookie 是否原样发出」。
2. 按 Edge「大声朗读」接口的格式回放一段 mp3，其中故意混入被拆成多次 TCP 写入的帧、
   WebSocket 分片消息和（音频够长时）超过 65535 字节的大帧，回答「listenReceiveData
   是否每次给完整一帧」。

用法：
    python3 scripts/poc/probe_server.py --audio /path/to/sample.mp3 [--port 18765] [--log probe.log]
然后在 Bob 里用 PoC 插件朗读文本「探针 ws://127.0.0.1:18765/probe」

按请求路径还能演几种异常，给插件的「诊断二」模式用（朗读「诊断 poc-diag2 ws://127.0.0.1:18765」）：
    /reject403    握手直接回 403 并断开，模仿微软拒绝握手
    /close-frame  发一帧音频后由服务端发 Close 帧（1011）
    /drop         发一帧音频后不打招呼直接断开 TCP
    /hang         握手成功后一声不吭，看客户端的 timeoutInterval 起不起作用
"""

import argparse
import base64
import hashlib
import socket
import struct
import sys
import threading
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
REQUEST_ID = "0123456789abcdef0123456789abcdef"
HEAD_CHUNK = 2000  # 前三段音频各 2000 字节，剩下的全部放进第四段

log_lock = threading.Lock()
log_file = None


def log(message):
    line = time.strftime("%H:%M:%S") + " " + message
    with log_lock:
        print(line, flush=True)
        if log_file is not None:
            log_file.write(line + "\n")
            log_file.flush()


def recv_exact(conn, count):
    buf = b""
    while len(buf) < count:
        part = conn.recv(count - len(buf))
        if not part:
            raise ConnectionError("peer closed")
        buf += part
    return buf


def read_request_head(conn):
    buf = b""
    while b"\r\n\r\n" not in buf:
        part = conn.recv(4096)
        if not part:
            break
        buf += part
        if len(buf) > 65536:
            break
    return buf


def read_frame(conn):
    b0, b1 = recv_exact(conn, 2)
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        (length,) = struct.unpack(">H", recv_exact(conn, 2))
    elif length == 127:
        (length,) = struct.unpack(">Q", recv_exact(conn, 8))
    mask = recv_exact(conn, 4) if masked else None
    payload = recv_exact(conn, length)
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return fin, opcode, masked, payload


def encode_frame(opcode, payload, fin=True):
    head = bytes([(0x80 if fin else 0) | opcode])
    size = len(payload)
    if size < 126:
        head += bytes([size])
    elif size < 65536:
        head += bytes([126]) + struct.pack(">H", size)
    else:
        head += bytes([127]) + struct.pack(">Q", size)
    return head + payload


def text_message(path, body="{}"):
    return (
        f"X-RequestId:{REQUEST_ID}\r\n"
        "Content-Type:application/json; charset=utf-8\r\n"
        f"Path:{path}\r\n\r\n{body}"
    ).encode("utf-8")


def audio_message(chunk):
    if chunk:
        head = f"X-RequestId:{REQUEST_ID}\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n"
    else:
        head = f"X-RequestId:{REQUEST_ID}\r\nPath:audio\r\n"
    head = head.encode("ascii")
    return struct.pack(">H", len(head)) + head + chunk


def replay(conn, audio):
    chunks = [audio[i * HEAD_CHUNK:(i + 1) * HEAD_CHUNK] for i in range(3)] + [audio[3 * HEAD_CHUNK:]]

    conn.sendall(encode_frame(1, text_message("turn.start")))
    conn.sendall(encode_frame(1, text_message("response")))

    msg = audio_message(chunks[0])
    conn.sendall(encode_frame(2, msg))
    log(f"sent binary #1 message={len(msg)} audio={len(chunks[0])} 单帧，一次写完")

    msg = audio_message(chunks[1])
    wire = encode_frame(2, msg)
    cut1, cut2 = 3, len(wire) // 2
    for part in (wire[:cut1], wire[cut1:cut2], wire[cut2:]):
        conn.sendall(part)
        time.sleep(0.15)
    log(f"sent binary #2 message={len(msg)} audio={len(chunks[1])} 单帧，拆成 3 次 TCP 写入（间隔 150ms）")

    conn.sendall(encode_frame(1, text_message("audio.metadata", '{"Metadata":[]}')))

    msg = audio_message(chunks[2])
    third = len(msg) // 3
    conn.sendall(encode_frame(2, msg[:third], fin=False))
    time.sleep(0.05)
    conn.sendall(encode_frame(0, msg[third:2 * third], fin=False))
    time.sleep(0.05)
    conn.sendall(encode_frame(0, msg[2 * third:], fin=True))
    log(f"sent binary #3 message={len(msg)} audio={len(chunks[2])} WebSocket 分片成 3 片")

    msg = audio_message(chunks[3])
    conn.sendall(encode_frame(2, msg))
    kind = "64 位长度大帧" if len(msg) > 65535 else "16 位长度单帧"
    log(f"sent binary #4 message={len(msg)} audio={len(chunks[3])} {kind}")

    msg = audio_message(b"")
    conn.sendall(encode_frame(2, msg))
    log(f"sent binary #5 message={len(msg)} audio=0 无 Content-Type 的结束帧")

    conn.sendall(encode_frame(1, text_message("turn.end")))
    log("sent text turn.end")
    log(f"expect: 5 次 listenReceiveData，message 长度依次为 "
        f"{[len(audio_message(c)) for c in chunks] + [len(audio_message(b''))]}；"
        f"音频合计 {len(audio)} 字节 sha256={hashlib.sha256(audio).hexdigest()}")


def handle(conn, peer, audio):
    conn.settimeout(40)
    try:
        head = read_request_head(conn)
        log(f"---- connection from {peer[0]}:{peer[1]}, request head {len(head)} bytes")
        log("RAW " + repr(head))
        lines = head.split(b"\r\n\r\n")[0].decode("latin-1").split("\r\n")
        for line in lines:
            log("HANDSHAKE | " + line)

        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers.setdefault(name.strip().lower(), []).append(value.strip())
        for name, values in headers.items():
            if len(values) > 1:
                log(f"DUPLICATE header {name}: {values}")

        path = lines[0].split(" ")[1].split("?")[0] if len(lines[0].split(" ")) > 1 else "/"
        if path == "/reject403":
            conn.sendall((
                "HTTP/1.1 403 Forbidden\r\n"
                f"Date: {time.strftime('%a, %d %b %Y %H:%M:%S GMT', time.gmtime())}\r\n"
                "Content-Length: 0\r\n\r\n"
            ).encode())
            log("scenario reject403: replied 403, closing TCP")
            return

        key = headers.get("sec-websocket-key", [""])[0]
        if "websocket" not in ",".join(headers.get("upgrade", [])).lower() or not key:
            log("not a websocket upgrade, closing")
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        conn.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode())
        log("handshake done, waiting for 2 client messages")

        received = 0
        replayed = False
        while True:
            fin, opcode, masked, payload = read_frame(conn)
            if opcode == 8:
                code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else None
                log(f"client CLOSE code={code} reason={payload[2:]!r}")
                conn.sendall(encode_frame(8, payload[:2]))
                return
            if opcode == 9:
                conn.sendall(encode_frame(10, payload))
                continue
            if opcode == 10:
                continue
            received += 1
            kind = {1: "text", 2: "binary", 0: "continuation"}.get(opcode, str(opcode))
            log(f"client message #{received} opcode={kind} fin={fin} masked={masked} bytes={len(payload)} "
                f"sha256={hashlib.sha256(payload).hexdigest()}")
            log("CLIENT " + repr(payload))
            if received == 2 and not replayed:
                replayed = True
                if path in ("/close-frame", "/drop"):
                    conn.sendall(encode_frame(1, text_message("turn.start")))
                    conn.sendall(encode_frame(2, audio_message(audio[:HEAD_CHUNK])))
                    time.sleep(0.3)
                    if path == "/close-frame":
                        conn.sendall(encode_frame(8, struct.pack(">H", 1011) + b"server going away"))
                        log("scenario close-frame: sent Close 1011 'server going away'")
                        time.sleep(0.5)
                    else:
                        log("scenario drop: closing TCP without a Close frame")
                    return
                if path == "/hang":
                    log("scenario hang: handshake done, staying silent")
                    continue
                replay(conn, audio)
    except (ConnectionError, socket.timeout, OSError) as exc:
        log(f"connection ended: {exc!r}")
    finally:
        conn.close()


def main():
    global log_file
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--audio", required=True, help="要回放的 mp3 文件")
    parser.add_argument("--log", help="同时把日志写到这个文件")
    args = parser.parse_args()

    with open(args.audio, "rb") as fh:
        audio = fh.read()
    if len(audio) <= 3 * HEAD_CHUNK:
        sys.exit(f"音频至少要 {3 * HEAD_CHUNK + 1} 字节")
    if args.log:
        log_file = open(args.log, "a", encoding="utf-8")

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(8)
    log(f"probe listening on ws://127.0.0.1:{args.port}/ audio={len(audio)} bytes")
    try:
        while True:
            conn, peer = server.accept()
            threading.Thread(target=handle, args=(conn, peer, audio), daemon=True).start()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    main()
