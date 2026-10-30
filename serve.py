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
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8787


# ============================================================
# 本地出图引擎（ComfyUI）管理
# 由 serve.py 作为本地宿主，负责「静默拉起 / 复用 / 路径管理」，
# 让画布无需用户手动启动 ComfyUI。
# ============================================================
class Engine:
    """本地 ComfyUI 引擎的进程管理与路径配置。

    设计要点：
    - 分离式：ComfyUI 以 start_new_session 独立存活，Loom 关闭不杀它，下次秒连。
    - 无状态探测：优先看 8188 端口是否在监听，其次看是否由我们记录的 pid 在跑。
    - 零依赖：只用标准库 subprocess / socket / urllib。
    """

    STATE_FILE = os.path.join(ROOT, ".engine.json")
    _lock = threading.Lock()

    def __init__(self):
        self._state = self._load_state()

    # ---------- 状态持久化 ----------
    def _load_state(self):
        try:
            with open(self.STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_state(self):
        try:
            with open(self.STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(self._state, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # ---------- 探测 ----------
    @staticmethod
    def port_open(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
            return False
        finally:
            s.close()

    def _pid_alive(self, pid):
        if not pid:
            return False
        try:
            os.kill(int(pid), 0)
            return True
        except OSError:
            return False

    # ---------- 配置 ----------
    def cfg(self):
        return {
            "comfy_dir": self._state.get("comfy_dir", ""),
            "port": int(self._state.get("port", 8188)),
            "extra_args": self._state.get("extra_args", []),
            "pid": self._state.get("pid", None),
        }

    def set_cfg(self, patch):
        with self._lock:
            if "port" in patch and patch["port"]:
                try:
                    patch["port"] = int(patch["port"])
                except ValueError:
                    patch["port"] = 8188
            self._state.update(patch)
            self._save_state()
        return self.cfg()

    # ---------- 路径管理 ----------
    def paths(self):
        return self._state.get("paths", {})

    def set_paths(self, mapping):
        """mapping: {"checkpoints": "/abs/dir", "vae": "/abs/dir", ...}
        写入 ComfyUI 的 extra_model_paths.yaml，让外部目录挂进 models/。
        """
        with self._lock:
            self._state["paths"] = mapping
            self._save_state()
        comfy_dir = self._state.get("comfy_dir", "")
        if comfy_dir and os.path.isdir(comfy_dir):
            self._write_yaml(comfy_dir, mapping)
        return self.paths()

    @staticmethod
    def _write_yaml(comfy_dir, mapping):
        """把外部模型目录写进 ComfyUI 的 extra_model_paths.yaml。

        ComfyUI 的标准写法：每个条目一个 base_path + 各子目录名。
        例如 mapping = {"checkpoints": "/Users/x/ComfyUI-Shared/models/checkpoints", ...}
        → 每个 key 的值就是该类型模型的绝对目录，直接作为 base_path 的对应子项。
        """
        target = os.path.join(comfy_dir, "extra_model_paths.yaml")
        lines = ["# 由 Loom 画布「高级选项」自动生成", "loom_shared:"]
        # 推导 base_path：取所有路径的公共父目录（通常是 .../models），
        # 再把各 key 映射成相对该 base_path 的子目录名。
        entries = [(k, v) for k, v in (mapping or {}).items() if v]
        if not entries:
            # 空映射：写一个占位，避免 ComfyUI 读到损坏的 yaml
            lines += ["    base_path: .", "    checkpoints: checkpoints"]
        else:
            # 简单方案：每个 key 直接作为一个独立 base_path 的别名，key 名即目录名
            # 这样不管用户路径多杂，都能各自指对
            for i, (key, path) in enumerate(entries):
                lines.append(f"  loom_{i}:")
                lines.append(f"    base_path: {os.path.dirname(os.path.abspath(path))}")
                lines.append(f"    {key}: {os.path.basename(os.path.abspath(path))}")
        try:
            with open(target, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
        except OSError as e:
            raise RuntimeError("写 extra_model_paths.yaml 失败：" + str(e))

    def listdir(self, path):
        """列出目录（供前端做路径选择器），限制在用户家目录内，防止越权浏览。"""
        p = os.path.abspath(os.path.expanduser(path or "~"))
        home = os.path.expanduser("~")
        if not (p == home or p.startswith(home + os.sep)):
            p = home
        try:
            entries = []
            for name in sorted(os.listdir(p)):
                full = os.path.join(p, name)
                if os.path.isdir(full):
                    entries.append({"name": name, "dir": True, "path": full})
            # 目录排前面，文件排后面（只列 .safetensors/.ckpt/.pt 等模型文件）
            for name in sorted(os.listdir(p)):
                full = os.path.join(p, name)
                if os.path.isfile(full) and name.lower().endswith(
                    (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf")
                ):
                    entries.append({"name": name, "dir": False, "path": full})
            parent = os.path.dirname(p)
            return {"path": p, "parent": parent if parent != p else None, "entries": entries}
        except OSError as e:
            return {"path": p, "error": str(e), "entries": []}

    # ---------- 启动 / 停止 ----------
    def _find_main(self, comfy_dir):
        for name in ("main.py", "main.pyw"):
            p = os.path.join(comfy_dir, name)
            if os.path.isfile(p):
                return p
        return None

    def _find_python(self, comfy_dir):
        """找到启动 ComfyUI 应该用的 Python。

        官方桌面版把引擎装成 comfy_dir/../standalone-env（自带 torch/yaml 等依赖），
        必须用它自带的 Python，不能用 serve.py 自己的 sys.executable（缺依赖）。
        """
        # 1) 同级 standalone-env（桌面版/独立版的典型布局：installPath/ComfyUI + installPath/standalone-env）
        parent = os.path.dirname(comfy_dir)
        candidates = [
            os.path.join(parent, "standalone-env", "bin", "python3"),
            os.path.join(parent, "standalone-env", "bin", "python"),
            os.path.join(parent, "venv", "bin", "python3"),
            os.path.join(parent, "venv", "bin", "python"),
            os.path.join(comfy_dir, "venv", "bin", "python3"),
            os.path.join(comfy_dir, ".venv", "bin", "python3"),
        ]
        for c in candidates:
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        # 2) 兜底：用当前 Python（可能缺依赖，但至少能跑起来报错给用户看）
        return sys.executable

    def start(self, wait=True, timeout=90):
        """拉起 ComfyUI。返回 (ok, message)。"""
        cfg = self.cfg()
        comfy_dir = cfg["comfy_dir"]
        port = cfg["port"]

        # 已经在跑了
        if self.port_open(port):
            return True, "已在运行"

        if not comfy_dir or not os.path.isdir(comfy_dir):
            return False, "还没配置 ComfyUI 目录"

        main = self._find_main(comfy_dir)
        if not main:
            return False, "ComfyUI 目录里没找到 main.py"

        py = self._find_python(comfy_dir)

        log_path = os.path.join(ROOT, ".engine.log")
        logf = open(log_path, "a", encoding="utf-8", errors="replace")
        cmd = [
            py, main,
            "--listen", "127.0.0.1",
            "--port", str(port),
        ] + list(cfg.get("extra_args") or [])
        try:
            proc = subprocess.Popen(
                cmd, cwd=comfy_dir,
                stdout=logf, stderr=logf,
                start_new_session=True,  # 分离式：独立存活
            )
        except OSError as e:
            return False, "启动失败：" + str(e)

        with self._lock:
            self._state["pid"] = proc.pid
            self._save_state()

        if not wait:
            return True, "已发起启动（pid %d）" % proc.pid

        # 轮询 /system_stats 直到就绪
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._probe_ready(port):
                return True, "已启动（pid %d）" % proc.pid
            if proc.poll() is not None:
                # 进程提前退出：把日志里最后一行真实原因带出来，别只说「连接被拒」
                tail = self._log_tail(3).strip().splitlines()
                reason = tail[-1] if tail else ""
                if len(reason) > 160:
                    reason = reason[:160]
                return False, ("引擎启动失败（exit %s）%s" % (proc.returncode, ("：%s" % reason) if reason else "，见 .engine.log"))
            time.sleep(1.5)
        return False, "启动超时（%ds），见 .engine.log" % timeout

    @staticmethod
    def _probe_ready(port):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:%d/system_stats" % port, timeout=3
            ) as r:
                return r.status == 200
        except Exception:
            return False

    def status(self):
        cfg = self.cfg()
        port = cfg["port"]
        running = self.port_open(port)
        return {
            "running": running,
            "port": port,
            "comfy_dir": cfg["comfy_dir"],
            "pid": cfg["pid"] if self._pid_alive(cfg["pid"]) else None,
            "paths": self.paths(),
            "log_tail": self._log_tail(),
        }

    def _log_tail(self, n=40):
        p = os.path.join(ROOT, ".engine.log")
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            return "".join(lines[-n:])
        except OSError:
            return ""

    def restart(self):
        cfg = self.cfg()
        pid = cfg.get("pid")
        if pid:
            try:
                os.kill(int(pid), 15)  # SIGTERM
                time.sleep(1.0)
            except OSError:
                pass
        # 若还有别的进程占着端口，尝试温和地结束它（仅限我们记录的 pid 之外不做，避免误杀）
        return self.start(wait=True)


ENGINE = Engine()



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

    # ---------------- /engine/* 本地引擎控制 ----------------
    def _engine_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _wants_engine(self):
        return self.path.split("?")[0].startswith("/engine")

    def _engine_route(self):
        path = self.path.split("?")[0]
        body = {}
        if self.command == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except Exception:
                    body = {}

        if path == "/engine/status":
            return self._engine_json(ENGINE.status())

        if path == "/engine/ensure":
            ok, msg = ENGINE.start(wait=True)
            return self._engine_json({"ok": ok, "message": msg, **ENGINE.status()},
                                     status=200 if ok else 503)

        if path == "/engine/restart":
            ok, msg = ENGINE.restart()
            return self._engine_json({"ok": ok, "message": msg, **ENGINE.status()},
                                     status=200 if ok else 503)

        if path == "/engine/config":
            cfg = ENGINE.set_cfg(body or {})
            return self._engine_json({"ok": True, **cfg})

        if path == "/engine/paths":
            paths = ENGINE.set_paths(body.get("paths") or body or {})
            return self._engine_json({"ok": True, "paths": paths})

        if path == "/engine/listdir":
            return self._engine_json(ENGINE.listdir((body or {}).get("path", "~")))

        return self._engine_json({"error": "unknown engine endpoint"}, 404)

    def do_GET(self):
        if self._wants_proxy():
            return self._proxy()
        if self._wants_engine():
            return self._engine_route()
        return super().do_GET()

    def do_HEAD(self):
        if self._wants_proxy():
            return self._proxy()
        return super().do_HEAD()

    def do_POST(self):
        if self._wants_proxy():
            return self._proxy()
        if self._wants_engine():
            return self._engine_route()
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
