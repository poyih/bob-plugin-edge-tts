#!/usr/bin/env python3
"""本机假的 Edge「大声朗读」服务端，用来在 Bob 里复现插件的重试、回退与超时逻辑。

只用标准库，只监听 127.0.0.1。第 N 条连接按 --seq 的第 N 项处理，用完之后都按最后一项：

    ok         正常：turn.start / response / 每帧 720 字节的音频 / 空结束帧 / turn.end
    close1011  收到 ssml 后发 turn.start 和一帧音频，再发 Close 1011 "Internal server error"
    hang       握手成功后一声不吭
    drop       发一帧音频后直接断开 TCP，不发 Close 帧
    reject403  握手直接回 403（插件会先校时重签，再按握手失败报错）
    reject503  握手直接回 503（瞬时故障，插件会重试）
    noaudio    turn.start / response / 空结束帧 / turn.end，没有音频

用法：
    python3 scripts/live/fake_edge.py --audio sample.mp3 --seq close1011,ok [--port 18766]

插件要连到这里，得装一个把 src/config.js 的 WSS_URL 改成 ws://127.0.0.1:18766/edge/v1 的临时包
（版本号改高一点，Bob 才会提示替换），测完换回正式包。时钟校准照样去请求微软的音色列表。
2026-09-28 用它在 Bob 1.21.0 里验证过 1.1.0 的六种故障，结论见 docs/poc-findings.md 第 11 节。
"""
import argparse
import base64
import hashlib
import socket
import struct
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
REQUEST_ID = "0123456789abcdef0123456789abcdef"
SCENARIOS = ("ok", "close1011", "hang", "drop", "reject403", "reject503", "noaudio")

counter_lock = threading.Lock()
counter = [0]


def log(message):
    print(time.strftime("%H:%M:%S") + " " + message, flush=True)


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        part = conn.recv(n - len(buf))
        if not part:
            raise ConnectionError("peer closed")
        buf += part
    return buf


def read_frame(conn):
    b0, b1 = recv_exact(conn, 2)
    opcode, length = b0 & 0x0F, b1 & 0x7F
    if length == 126:
        (length,) = struct.unpack(">H", recv_exact(conn, 2))
    elif length == 127:
        (length,) = struct.unpack(">Q", recv_exact(conn, 8))
    mask = recv_exact(conn, 4) if b1 & 0x80 else None
    data = recv_exact(conn, length)
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def frame(opcode, payload):
    n = len(payload)
    if n < 126:
        head = struct.pack(">BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack(">BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack(">BBQ", 0x80 | opcode, 127, n)
    return head + payload


def text_frame(path, body="{}"):
    return frame(1, ("X-RequestId:%s\r\nContent-Type:application/json; charset=utf-8\r\nPath:%s\r\n\r\n%s"
                     % (REQUEST_ID, path, body)).encode())


def audio_frame(chunk, with_content_type=True):
    header = ("X-RequestId:%s\r\n" % REQUEST_ID + ("Content-Type:audio/mpeg\r\n" if with_content_type else "") +
              "X-StreamId:1E708CCA91694AA5B8939B0B6CED7DCE\r\nPath:audio\r\n").encode()
    return frame(2, struct.pack(">H", len(header)) + header + chunk)


def wait_ssml(conn):
    while True:
        opcode, data = read_frame(conn)
        if opcode == 8:
            raise ConnectionError("client closed before ssml")
        if opcode == 1 and b"Path:ssml" in data:
            return


def drain(conn, n):
    """读到客户端的 Close 帧为止，回一个 Close。"""
    conn.settimeout(20)
    try:
        while True:
            opcode, _ = read_frame(conn)
            if opcode == 8:
                conn.sendall(frame(8, struct.pack(">H", 1000)))
                log("#%d client sent Close, replied and closing" % n)
                return
    except Exception as err:  # 超时或对方断开都算结束
        log("#%d connection ended: %s" % (n, err))


def handle(conn, audio, scenario, n):
    try:
        head = b""
        while b"\r\n\r\n" not in head:
            part = conn.recv(4096)
            if not part:
                return
            head += part
        lines = head.decode("latin-1").split("\r\n")
        key = next((l.split(":", 1)[1].strip() for l in lines if l.lower().startswith("sec-websocket-key:")), "")
        log("#%d %s <- %s..." % (n, scenario, lines[0][:60]))
        if scenario in ("reject403", "reject503"):
            status = "403 Forbidden" if scenario == "reject403" else "503 Service Unavailable"
            conn.sendall(("HTTP/1.1 %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" % status).encode())
            log("#%d replied %s" % (n, status))
            return
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        if scenario == "hang":
            log("#%d handshake done, staying silent" % n)
            drain(conn, n)
            return
        wait_ssml(conn)
        conn.sendall(text_frame("turn.start", '{"context":{"serviceTag":"fake"}}'))
        if scenario in ("close1011", "drop"):
            conn.sendall(audio_frame(audio[:720]))
            time.sleep(0.2)
            if scenario == "close1011":
                conn.sendall(frame(8, struct.pack(">H", 1011) + b"Internal server error"))
                log("#%d sent one audio frame then Close 1011" % n)
                drain(conn, n)
            else:
                conn.shutdown(socket.SHUT_RDWR)
                log("#%d sent one audio frame then dropped TCP" % n)
            return
        conn.sendall(text_frame("response", '{"audio":{"type":"inline"}}'))
        if scenario == "ok":
            for i in range(0, len(audio), 720):
                conn.sendall(audio_frame(audio[i:i + 720]))
        conn.sendall(audio_frame(b"", with_content_type=False))
        conn.sendall(text_frame("turn.end"))
        log("#%d sent %s + turn.end" % (n, "audio %d bytes" % len(audio) if scenario == "ok" else "no audio"))
        drain(conn, n)
    except Exception as err:
        log("#%d error: %s" % (n, err))
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audio", required=True, help="回放的 mp3 文件")
    parser.add_argument("--seq", required=True, help="逗号分隔的场景序列，可选：" + " ".join(SCENARIOS))
    parser.add_argument("--port", type=int, default=18766)
    args = parser.parse_args()
    seq = args.seq.split(",")
    unknown = [s for s in seq if s not in SCENARIOS]
    if unknown:
        parser.error("未知场景：" + ", ".join(unknown))
    audio = open(args.audio, "rb").read()
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(8)
    log("listening on 127.0.0.1:%d seq=%s" % (args.port, seq))
    while True:
        conn, _ = server.accept()
        with counter_lock:
            counter[0] += 1
            n = counter[0]
        scenario = seq[min(n - 1, len(seq) - 1)]
        threading.Thread(target=handle, args=(conn, audio, scenario, n), daemon=True).start()


if __name__ == "__main__":
    main()
