#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 织造所 · 本地启动器
零依赖：只用 Python 标准库。

用法：
    python3 serve.py            # 自动找端口并打开浏览器
    python3 serve.py 9000       # 指定端口
    python3 serve.py --no-open  # 只起服务，不打开浏览器
"""

import http.server
import os
import socket
import socketserver
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8787


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # 代码与页面禁用缓存（改完刷新即生效），图片与字体长缓存（2900+ 张参考图不要反复拉）
        path = self.path.split("?")[0].lower()
        if path.endswith((".webp", ".png", ".jpg", ".jpeg", ".avif", ".gif", ".woff2")):
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静默掉每张图的访问日志，只在出错时提示
        if args and str(args[1]) not in ("200", "304", "206"):
            sys.stderr.write("  %s\n" % (fmt % args))

    # ---------------- /comfy?u=<url> 本地反代 ----------------
    # ComfyUI 新版会拒绝陌生 Origin（403，无 CORS 头），浏览器 fetch 直连必挂；
    # 由这个仅监听 127.0.0.1 的本地服务代为转发，绕开浏览器的跨域限制。
    FORWARDED_HEADERS = ("Content-Type", "Accept", "Authorization")

    def _send_proxy(self, status, data, ctype="application/json"):
        self.send_response(status)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy(self):
        qs = parse_qs(urlparse(self.path).query)
        target = (qs.get("u") or [""])[0]
        u = urlparse(target)
        host = self.headers.get("Host", "")
        if u.scheme not in ("http", "https") or not u.netloc:
            return self._send_proxy(400, b'{"error":"bad target"}', "application/json")
        if u.netloc == host or u.netloc.endswith(":" + str(self.server.server_address[1])):
            return self._send_proxy(400, b'{"error":"loop not allowed"}', "application/json")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(target, data=body, method=self.command)
        for h in self.FORWARDED_HEADERS:
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                self._send_proxy(r.status, r.read(), r.headers.get("Content-Type"))
        except urllib.error.HTTPError as e:
            try:
                data = e.read()
            except Exception:
                data = b""
            self._send_proxy(e.code, data, e.headers.get("Content-Type") if e.headers else None)
        except Exception as e:
            self._send_proxy(502, ("proxy error: %s" % e).encode("utf-8"), "text/plain; charset=utf-8")

    def _wants_proxy(self):
        return self.path.split("?")[0] == "/comfy"

    def do_GET(self):
        if self._wants_proxy():
            return self._proxy()
        return super().do_GET()

    def do_HEAD(self):
        if self._wants_proxy():
            return self._proxy()
        return super().do_HEAD()

    def do_POST(self):
        if self._wants_proxy():
            return self._proxy()
        self.send_error(501, "Unsupported method (%r)" % self.command)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def free_port(start):
    for p in range(start, start + 60):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def main():
    argv = [a for a in sys.argv[1:]]
    no_open = "--no-open" in argv
    argv = [a for a in argv if not a.startswith("--")]

    port = int(argv[0]) if argv and argv[0].isdigit() else free_port(DEFAULT_PORT)
    url = f"http://127.0.0.1:{port}/"

    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print("✕ 没找到 index.html，请在项目目录里运行这个脚本")
        return 1

    httpd = Server(("127.0.0.1", port), Handler)

    print("")
    print("  ┌──────────────────────────────────────────┐")
    print("  │   Loom · 织造所" + " " * 24 + "│")
    print("  └──────────────────────────────────────────┘")
    print(f"   地址：{url}")
    print(f"   目录：{ROOT}")
    print("   数据保存在这个浏览器的 IndexedDB 里（换浏览器不相通）")
    print("   按 Ctrl+C 停止")
    print("")

    if not no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
