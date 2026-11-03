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
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import tarfile
import tempfile
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
    # 单独抽出来是为了测试能模拟 Windows 分支（不真的改 os.name）
    IS_WIN = os.name == "nt"

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
    def _auto_discover(self):
        """自动探测 setup-engine 脚本安装的引擎目录（engine/main.py 或 engine/ComfyUI/main.py）"""
        for sub in ("engine", "engine/ComfyUI"):
            p = os.path.join(ROOT, sub, "main.py")
            if os.path.isfile(p):
                return os.path.dirname(p)
        return ""

    def cfg(self):
        comfy_dir = self._state.get("comfy_dir", "")
        if not comfy_dir:
            comfy_dir = self._auto_discover()
        return {
            "comfy_dir": comfy_dir,
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

        ComfyUI 的格式是「每个顶层 section 一个 base_path + 若干子目录名」：
            loom_0:
                base_path: /path/to/models
                loras: loras
                vae: vae
        注意不能把所有 section 再套一层（之前套了 loom_shared:，ComfyUI 会把
        loom_0 当成字典值，读取时抛 AttributeError: 'dict' object has no attribute 'split'）。
        同一个 base_path 下多个类型合并成一个 section，文件更短也更好读。
        """
        target = os.path.join(comfy_dir, "extra_model_paths.yaml")

        def norm(p):
            p = os.path.abspath(os.path.expanduser(p))
            # Windows 上写正斜杠：YAML 里反斜杠容易被当转义
            return p.replace("\\", "/") if os.name == "nt" else p

        own = norm(os.path.join(comfy_dir, "models"))
        entries = [(k, norm(v)) for k, v in (mapping or {}).items() if v]
        # ComfyUI 自己就认 models/ 下的目录，写进去只会让模型列表重复一遍
        entries = [(k, p) for k, p in entries if p != own and not p.startswith(own + os.sep)]
        lines = ["# 由 Loom 自动生成：设置 / 画布「高级选项」里改路径后会自动重写此文件", ""]
        if not entries:
            lines += ["loom:", "    base_path: .", "    checkpoints: models/checkpoints"]
        else:
            groups = {}
            for key, path in entries:
                groups.setdefault(os.path.dirname(path), []).append((key, os.path.basename(path)))
            for i, (base, items) in enumerate(groups.items()):
                lines.append("loom_%d:" % i)
                lines.append("    base_path: %s" % base)
                for key, name in items:
                    lines.append("    %s: %s" % (key, name))
                lines.append("")
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

    # ---------- 出图目录 ----------
    def outputs(self, limit=60):
        """列出 ComfyUI/output 下的图，最新在前。给「从引擎导入」用。"""
        cfg = self.cfg()
        comfy_dir = cfg["comfy_dir"]
        if not comfy_dir:
            return {"dir": "", "items": []}
        out_dir = os.path.join(comfy_dir, "output")
        items = []
        try:
            for name in os.listdir(out_dir):
                if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    continue
                full = os.path.join(out_dir, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                items.append({"name": name, "size": st.st_size, "mtime": int(st.st_mtime)})
        except OSError:
            pass
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return {"dir": out_dir, "items": items[:limit], "total": len(items)}

    # ---------- 模型目录自动识别 ----------
    # 常见布局是 <安装根>/models/{checkpoints,loras,vae,...}（放在 ComfyUI 外面，
    # 这样换/升级 ComfyUI 不会把模型一起删掉）。这里扫一遍并映射成 ComfyUI 的类型名。
    # 只有这些后缀才算「真模型」：ComfyUI 空目录里会放 put_xxx_here 占位文件，
    # 不能拿它当「这个目录有内容」
    MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx")
    # 正在下载的临时文件（迅雷/夸克/aria2 等）：算「这个目录是对的」，但不计入可用模型数
    PARTIAL_MARKS = (".qkdownloading", ".part", ".download", ".downloading", ".crdownload",
                     ".aria2", ".tmp", ".partial")

    MODEL_ALIASES = {
        "checkpoints": ("checkpoints", "checkpoint", "stable-diffusion", "ckpt"),
        "diffusion_models": ("diffusion_models", "diffusion-models", "unet"),
        "loras": ("loras", "lora"),
        "vae": ("vae",),
        "clip": ("clip",),
        "text_encoders": ("text_encoders", "text-encoders", "textencoder", "t5"),
        "clip_vision": ("clip_vision", "clip-vision"),
        "controlnet": ("controlnet", "control_net"),
        "upscale_models": ("upscale_models", "upscalers", "upscale"),
        "embeddings": ("embeddings", "embedding"),
    }

    def _model_roots(self, comfy_dir):
        roots = []
        if comfy_dir:
            parent = os.path.dirname(os.path.abspath(comfy_dir).rstrip(os.sep))
            roots.append((os.path.join(parent, "models"), "安装目录旁的 models"))
            roots.append((os.path.join(comfy_dir, "models"), "ComfyUI 自带 models"))
        home = os.path.expanduser("~")
        for name in ("ComfyUI", "ComfyUI-Shared", "comfyui",
                     "ComfyUI_windows_portable/ComfyUI", "Documents/ComfyUI"):
            roots.append((os.path.join(home, name, "models"), "~/" + name + "/models"))
        seen, out = set(), []
        for p, label in roots:
            p = os.path.abspath(os.path.expanduser(p))
            if p in seen:
                continue
            seen.add(p)
            if os.path.isdir(p):
                out.append({"path": p, "label": label})
        return out

    @classmethod
    def _type_of_dir(cls, name):
        low = name.lower()
        for key, aliases in cls.MODEL_ALIASES.items():
            if low in aliases:
                return key
        return ""

    def scan_models(self):
        """扫本机所有可能的 models 根目录，按类型挑最合适的那一个。"""
        cfg = self.cfg()
        comfy_dir = cfg["comfy_dir"]
        roots = self._model_roots(comfy_dir)
        order = {r["path"]: i for i, r in enumerate(roots)}
        detail = []
        best = {}
        for root in roots:
            try:
                names = sorted(os.listdir(root["path"]))
            except OSError:
                continue
            for name in names:
                full = os.path.join(root["path"], name)
                if not os.path.isdir(full):
                    continue
                key = self._type_of_dir(name)
                if not key:
                    continue
                files, partial = self._count_models(full)
                detail.append({"type": key, "path": full, "files": files,
                               "partial": partial, "root": root["path"]})
                # 评分：有内容（含正在下载）优先 > 可用模型多优先 > 靠前的根目录优先
                has_content = 1 if (files > 0 or partial > 0) else 0
                score = (has_content, files * 2 + partial, -order.get(root["path"], 99))
                cur = best.get(key)
                if cur is None or score > cur[0]:
                    best[key] = (score, full, files, partial)
        found = {k: v[1] for k, v in best.items()}
        counted = {k: v[2] for k, v in best.items()}
        partials = {k: v[3] for k, v in best.items()}
        return {
            "comfy_dir": comfy_dir,
            "roots": roots,
            "found": found,
            "files": counted,
            "partial": partials,
            "detail": detail,
            "configured": self._state.get("paths", {}),
        }

    def _count_models(self, path):
        """返回 (可用模型数, 正在下载数)。"""
        ready = partial = 0
        try:
            names = os.listdir(path)
        except OSError:
            return 0, 0
        for f in names:
            low = f.lower()
            full = os.path.join(path, f)
            if not os.path.isfile(full):
                continue
            if low.endswith(self.PARTIAL_MARKS):
                partial += 1
            elif low.endswith(self.MODEL_EXTS):
                ready += 1
        return ready, partial

    def auto_mount_models(self, comfy_dir):
        """没手工配过路径时，把识别到的模型目录写进 extra_model_paths.yaml。"""
        if self._state.get("paths"):
            return {}
        try:
            scan = self.scan_models()
        except Exception:
            return {}
        found = scan.get("found") or {}
        if not found:
            return {}
        # ComfyUI 自带的 models 目录本来就会被读到，不用再挂一遍
        own = os.path.abspath(os.path.join(comfy_dir, "models"))
        found = {k: v for k, v in found.items()
                 if os.path.abspath(v) != own
                 and not os.path.abspath(v).startswith(own + os.sep)}
        if not found:
            return {}
        target = os.path.join(comfy_dir, "extra_model_paths.yaml")
        ours = True
        if os.path.isfile(target):
            try:
                with open(target, "r", encoding="utf-8", errors="replace") as f:
                    ours = f.read(200).lstrip().startswith("# 由 Loom")
            except OSError:
                ours = False
        if not ours:
            return {}
        try:
            self._write_yaml(comfy_dir, found)
        except Exception:
            return {}
        with self._lock:
            self._state["paths"] = found
            self._save_state()
        print("  [engine] 自动挂载模型目录：%s" % ", ".join(
            "%s=%s" % (k, v) for k, v in sorted(found.items())))
        return found

    # ---------- 启动 / 停止 ----------
    def _find_main(self, comfy_dir):
        for name in ("main.py", "main.pyw"):
            p = os.path.join(comfy_dir, name)
            if os.path.isfile(p):
                return p
        return None

    def _find_python(self, comfy_dir):
        """找到启动 ComfyUI 应该用的 Python。

        覆盖三种常见安装形态：
        - Loom 一键安装 / 绿色整合包：installPath/ComfyUI + installPath/venv
        - 官方桌面版：installPath/ComfyUI + installPath/standalone-env
        - 官方 Windows 便携包：ComfyUI_windows_portable/ComfyUI + ComfyUI_windows_portable/python_embeded/python.exe
        必须用它自带的 Python，不能用 serve.py 自己的 sys.executable（缺 torch 等依赖）。
        """
        parent = os.path.dirname(comfy_dir)
        roots = [parent, comfy_dir]
        rels = [
            ("standalone-env", "bin", "python3"),
            ("standalone-env", "bin", "python"),
            ("venv", "bin", "python3"),
            ("venv", "bin", "python"),
            (".venv", "bin", "python3"),
            ("standalone-env", "Scripts", "python.exe"),
            ("venv", "Scripts", "python.exe"),
            (".venv", "Scripts", "python.exe"),
            ("python_embeded", "python.exe"),
            ("python_embedded", "python.exe"),
        ]
        candidates = [os.path.join(r, *rel) for r in roots for rel in rels]
        for c in candidates:
            if os.path.isfile(c) and (os.name == "nt" or os.access(c, os.X_OK)):
                return c
        # 兜底：用当前 Python（可能缺依赖，但至少能跑起来报错给用户看）
        return sys.executable

    def start(self, wait=True, timeout=180):
        """拉起 ComfyUI。返回 (ok, message)。"""
        cfg = self.cfg()
        comfy_dir = cfg["comfy_dir"]
        port = cfg["port"]

        # 冷启动前：把手动没配过、但能识别到的模型目录自动挂上
        if comfy_dir and os.path.isdir(comfy_dir):
            try:
                self.auto_mount_models(comfy_dir)
            except Exception:
                pass

        # 已经在跑了
        if self.port_open(port):
            return True, "已在运行"

        if not comfy_dir or not os.path.isdir(comfy_dir):
            return False, "还没配置 ComfyUI 目录"

        main = self._find_main(comfy_dir)
        if not main:
            return False, "ComfyUI 目录里没找到 main.py"

        py = self._find_python(comfy_dir)
        vv = Installer._py_ver(py)
        if vv[0] and vv < Installer.MIN_PY:
            return False, (
                "这个引擎用的是 Python %d.%d，ComfyUI 要求 3.10+，会直接抛 "
                "TypeError: unsupported operand type(s) for |。"
                "回到上面点「下载并安装」，新版会自动找 3.10+ 重建环境。" % vv)

        log_path = os.path.join(ROOT, ".engine.log")
        logf = open(log_path, "a", encoding="utf-8", errors="replace")
        extra = list(cfg.get("extra_args") or [])
        # 允许浏览器直连：不加的话每个请求都要先吃一个 403 再走 serve.py 反代，
        # 而且 WebSocket 连不上 → 进度只能显示「生成中 233s」，看不到 2/10 这种步进。
        if not any(str(a).startswith("--enable-cors-header") for a in extra):
            extra = ["--enable-cors-header"] + extra
        cmd = [
            py, main,
            "--listen", "127.0.0.1",
            "--port", str(port),
        ] + extra
        # 引擎同样要一个干净的环境：继承宿主 PYTHONPATH 会让 ComfyUI 加载到
        # 别处的 sitecustomize，表现为启动后卡住不动（没有报错，也没有监听端口）
        env = os.environ.copy()
        for _k in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
            env.pop(_k, None)
        env["PYTHONUNBUFFERED"] = "1"
        try:
            proc = subprocess.Popen(
                cmd, cwd=comfy_dir, env=env,
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
            with Engine._local_opener().open(
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

    # ---------- 资源监控（/engine/sys） ----------
    # ComfyUI 的 /system_stats 只报显存与版本；CPU、进程内存、NVIDIA 利用率都得
    # 自己问系统。这些调用都不便宜（ps 约 30ms，PowerShell 800ms+），统一走 2 秒
    # 缓存，前端 1.5 秒轮询一次也不会把机器拖住。
    _sys_cache = {"t": 0.0, "data": None}

    @staticmethod
    def _cpu_percent():
        """整机 CPU 占用百分比。拉不到就返回 None（界面显示 —— 而不是假装 0）。"""
        cores = max(1, os.cpu_count() or 1)
        try:
            if Engine.IS_WIN:
                out = Engine._powershell(
                    "(Get-CimInstance Win32_Processor | "
                    "Measure-Object -Property LoadPercentage -Average).Average", timeout=5)
                if not out:
                    raise ValueError('PowerShell 没返回')
                v = float(out.strip().replace(",", "."))
            else:
                # ps 的 %cpu 是「相对单个核」的，多线程加起来会超过 100；
                # 除以核数才是任务管理器里那个整机占用。
                r = subprocess.run(["ps", "-A", "-o", "%cpu="], capture_output=True,
                                   text=True, timeout=5)
                body = (r.stdout or "").strip()
                if r.returncode != 0 or not body:
                    raise OSError('ps 没有输出')
                total = 0.0
                for tok in body.split():
                    try:
                        total += float(tok)
                    except ValueError:
                        pass
                v = total / cores
        except Exception:
            # ps 被系统策略挡住时（沙箱 / 托管环境）退回 1 分钟平均负载。
            # 精度差一点，也比让面板永远显示「—」强；Windows 上会抛
            # NotImplementedError，自然落到 None。
            try:
                v = os.getloadavg()[0] / cores * 100
            except Exception:
                return None
        return round(max(0.0, min(100.0, v)), 1)

    @staticmethod
    def _parse_etime(s):
        """ps 的 etime 格式 → 秒：'05:20' / '13:02:11' / '2-03:04:05'。"""
        s = str(s or "").strip()
        if not s:
            return None
        days = 0
        if "-" in s:
            d, s = s.split("-", 1)
            try:
                days = int(d)
            except ValueError:
                return None
        try:
            nums = [int(float(x)) for x in s.split(":")]
        except ValueError:
            return None
        if len(nums) == 3:
            h, m, sec = nums
        elif len(nums) == 2:
            h, m, sec = 0, nums[0], nums[1]
        elif len(nums) == 1:
            h, m, sec = 0, 0, nums[0]
        else:
            return None
        return days * 86400 + h * 3600 + m * 60 + sec

    @staticmethod
    def _proc_usage(pid):
        """引擎进程的常驻内存（字节）与已运行秒数。拿不到返回 (None, None)。"""
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return None, None
        if Engine.IS_WIN:
            out = Engine._powershell(
                "$p=Get-Process -Id %d -ErrorAction SilentlyContinue;"
                "if($p){ \"{0}|{1}\" -f $p.WorkingSet64,"
                "[int]((Get-Date)-$p.StartTime).TotalSeconds }" % pid, timeout=8)
            if "|" not in out:
                return None, None
            rss, up = out.split("|", 1)
            try:
                return int(float(rss)), int(float(up))
            except ValueError:
                return None, None
        try:
            r = subprocess.run(["ps", "-o", "rss=,etime=", "-p", str(pid)],
                               capture_output=True, text=True, timeout=5)
            lines = (r.stdout or "").strip().splitlines()
            if not lines:
                return None, None
            toks = lines[-1].split()
            rss = int(toks[0]) * 1024           # ps 的 rss 单位是 KB
            up = Engine._parse_etime(toks[1]) if len(toks) > 1 else None
            return rss, up
        except Exception:
            return None, None

    @staticmethod
    def _gpu_util():
        """NVIDIA 显卡利用率（0~100）。macOS / 纯 CPU 机器上没有 nvidia-smi，返回 None。"""
        exe = shutil.which("nvidia-smi")
        if not exe:
            return None
        try:
            r = subprocess.run(
                [exe, "--query-gpu=utilization.gpu,memory.used,memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=6,
                **Engine._no_window_kwargs())
            lines = (r.stdout or "").strip().splitlines()
            if not lines:
                return None
            toks = [t.strip() for t in lines[0].split(",")]
            out = {"util": float(toks[0])}
            if len(toks) >= 3:
                out["mem_used"] = int(float(toks[1])) * 1024 * 1024
                out["mem_total"] = int(float(toks[2])) * 1024 * 1024
            return out
        except Exception:
            return None

    def sys(self):
        """资源面板数据：引擎存活 / 端口 / pid / CPU / 进程内存 / GPU 利用率。

        显存、RAM、版本号由前端另问 /system_stats（那边更准，也能直连）；
        这里只补 ComfyUI 自己不会说的那部分。
        """
        now = time.time()
        cache = Engine._sys_cache
        if cache["data"] is not None and now - cache["t"] < 2.0:
            return cache["data"]

        cfg = self.cfg()
        port = int(cfg.get("port", 8188))
        running = self.port_open(port)

        # 不盲信 .engine.json 里的 pid：用户手动起的 ComfyUI 也要能测到内存
        pid = None
        if running:
            owners = sorted(self._port_pids(port))
            try:
                recorded = int(cfg.get("pid") or 0) or None
            except (TypeError, ValueError):
                recorded = None
            if recorded and recorded in owners:
                pid = recorded
            elif owners:
                pid = owners[0]
            else:
                pid = recorded

        rss, uptime = self._proc_usage(pid) if pid else (None, None)
        data = {
            "running": running,
            "port": port,
            "pid": pid,
            "cpu": {"pct": self._cpu_percent(), "cores": os.cpu_count() or 1},
            "proc": {"rss": rss, "uptime": uptime},
            "gpu": self._gpu_util(),
            "ts": now,
        }
        cache["data"], cache["t"] = data, now
        return data

    def _log_tail(self, n=40):
        p = os.path.join(ROOT, ".engine.log")
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            return "".join(lines[-n:])
        except OSError:
            return ""

    # ---------- 重启 ----------
    @staticmethod
    def _local_opener():
        """访问 127.0.0.1 专用：绕开 http_proxy/no_proxy 配置。

        系统里一旦设了 http_proxy 又没把 127.0.0.1 放进 no_proxy，探测请求就会
        被代理接走并失败 —— 表现为「引擎明明活着，却说它没启动」。
        """
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @staticmethod
    def _no_window_kwargs():
        if Engine.IS_WIN:
            return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
        return {}

    @staticmethod
    def _powershell(script, timeout=15):
        """跑一段 PowerShell 并返回 stdout（失败返回空串）。Windows 专用。"""
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, timeout=timeout,
                **Engine._no_window_kwargs()
            )
            return (r.stdout or "").strip()
        except Exception:
            return ""

    @staticmethod
    def _port_pids(port):
        """找出真正占着端口的进程 pid（不信任 .engine.json 里存的 pid）。

        macOS / Linux 用 lsof；Windows 没有 lsof，用 Get-NetTCPConnection -State Listen。
        只取「监听中」的进程：否则浏览器连上 8188 的那条 ESTABLISHED 连接会把
        浏览器的 pid 也查出来，一杀就把用户的浏览器关了。
        """
        pids = set()
        port = int(port)
        if Engine.IS_WIN:
            out = Engine._powershell(
                "(Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue)"
                ".OwningProcess" % port)
            for tok in out.split():
                if tok.isdigit():
                    pids.add(int(tok))
            if pids:
                return pids
            # PowerShell 不可用（被裁过的系统）时退回 netstat，只认 LISTENING 行
            try:
                r = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                                   capture_output=True, text=True, timeout=15,
                                   **Engine._no_window_kwargs())
                for line in (r.stdout or "").splitlines():
                    parts = line.split()
                    if len(parts) < 5 or not parts[0].upper().startswith("TCP"):
                        continue
                    if not parts[1].endswith(":" + str(port)):
                        continue
                    if "LISTEN" not in parts[3].upper():
                        continue
                    if parts[4].isdigit():
                        pids.add(int(parts[4]))
            except Exception:
                pass
            return pids

        try:
            r = subprocess.run(["lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t"],
                               capture_output=True, text=True, timeout=10)
            for tok in (r.stdout or "").split():
                if tok.strip().isdigit():
                    pids.add(int(tok))
        except Exception:
            pass
        return pids

    @staticmethod
    def _looks_like_comfy(pid):
        """确认这个 pid 真的是 ComfyUI，避免 pid 被系统复用后误杀别的进程。"""
        cmd = ""
        if Engine.IS_WIN:
            cmd = Engine._powershell(
                "(Get-CimInstance Win32_Process -Filter 'ProcessId=%d')"
                ".CommandLine" % int(pid), timeout=10)
            if not cmd:
                try:
                    r = subprocess.run(["tasklist", "/FI", "PID eq %d" % int(pid), "/FO", "CSV", "/NH"],
                                       capture_output=True, text=True, timeout=10,
                                       **Engine._no_window_kwargs())
                    cmd = (r.stdout or "").strip()
                except Exception:
                    cmd = ""
        else:
            try:
                r = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                   capture_output=True, text=True, timeout=10)
                cmd = (r.stdout or "").strip()
            except Exception:
                return False
        if not cmd:
            return False
        low = cmd.lower()
        return ("comfyui/main.py" in low) or ("main.py" in low and "python" in low)

    @staticmethod
    def _is_comfy_port(port):
        """这个端口上跑的到底是不是 ComfyUI？直接问它本人最准（ps 不可靠时用）。"""
        try:
            with Engine._local_opener().open("http://127.0.0.1:%d/system_stats" % int(port), timeout=3) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
            return bool(isinstance(j, dict) and (j.get("system") or j.get("devices")))
        except Exception:
            return False

    def restart(self):
        cfg = self.cfg()
        port = int(cfg.get("port", 8188))

        # 只杀「占着这个端口、而且确认是 ComfyUI」的进程。
        # 旧实现直接 os.kill(.engine.json 里记的 pid)，pid 被系统复用后
        # 可能把别的程序（甚至 serve.py 自己）杀掉。
        owners = sorted(self._port_pids(port))
        comfy_here = self._is_comfy_port(port)

        # 我们自己启动引擎时记下了 pid。只要这个 pid 现在确实占着端口，
        # 就可以确认它是我们的引擎 —— 即使它卡在加载模型里、/system_stats 不回应，
        # 也能安全重启（这种「卡死」正是最需要重启的时候）。
        recorded = cfg.get("pid")
        try:
            recorded = int(recorded) if recorded else None
        except (TypeError, ValueError):
            recorded = None
        trusted = recorded if (recorded and recorded in owners) else None

        if owners and not comfy_here and not trusted and not any(self._looks_like_comfy(p) for p in owners):
            return False, ("端口 %d 被一个不认识的进程占着（不是 ComfyUI？），没有动它。"
                           "可以手动关掉那个程序，或改端口。" % port)

        killed = []
        for pid in owners:
            if not (comfy_here or trusted == pid or self._looks_like_comfy(pid)):
                continue
            try:
                os.kill(pid, 15)
                killed.append(pid)
            except OSError:
                pass

        if killed:
            for _ in range(40):
                if not self.port_open(port):
                    break
                time.sleep(0.5)
            else:
                for pid in killed:      # 还不走就强杀
                    try:
                        os.kill(pid, 9)
                    except OSError:
                        pass
                time.sleep(1.2)

        with self._lock:
            self._state["pid"] = None
            self._save_state()

        return self.start(wait=True)


# ============================================================
# 一键安装 ComfyUI
# 由 serve.py 代劳「下载源码 → 建独立环境 → 装 PyTorch/依赖 → 写配置」，
# 前端只负责点一下、看进度。Windows 上可以自选安装盘符/目录。
# ============================================================
class Installer:
    """ComfyUI 安装器。

    与 scripts/setup-engine.sh 的关系：两者装出来的东西一致（<target>/ComfyUI + <target>/venv），
    只是这里把过程搬进了图形界面，并且：
    - 原生文件夹选择框（Windows 用 PowerShell 的 FolderBrowserDialog，mac 用 osascript）
    - 全程日志 + 分步进度，失败能看见真实原因
    - 源码获取双通道：git clone 失败自动退到 codeload 压缩包（国内 git 常被墙）
    - pip 下载进度实时回传（按 \\r 切分，pip 的进度条才能动起来）
    """

    COMFY_GIT = "https://github.com/comfyanonymous/ComfyUI.git"
    CODELOAD = "https://codeload.github.com/comfyanonymous/ComfyUI/tar.gz/refs/heads/master"
    PYPI_OFFICIAL = "https://pypi.org/simple"
    PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
    TORCH_INDEX = {
        "cpu": "https://download.pytorch.org/whl/cpu",
        "cu124": "https://download.pytorch.org/whl/cu124",
        "cu126": "https://download.pytorch.org/whl/cu126",
    }
    STEPS = [
        ("prepare", "准备安装目录"),
        ("source", "获取 ComfyUI 源码"),
        ("venv", "创建独立 Python 环境"),
        ("torch", "安装 PyTorch"),
        ("deps", "安装 ComfyUI 依赖"),
        ("config", "写入配置并自检"),
    ]
    MAX_LOG = 600

    def __init__(self):
        self._lock = threading.Lock()
        self._proc = None
        self._reset()

    def _reset(self):
        self._s = {
            "running": False, "ok": None, "error": "", "target": "", "comfy_dir": "",
            "steps": [{"key": k, "label": l, "state": "pending"} for k, l in self.STEPS],
            "log": [], "started": 0.0, "finished": 0.0, "torch": "auto", "mirror": True,
            "canceled": False,
        }

    # ---------- 对外状态 ----------
    @staticmethod
    def default_target():
        """默认装到用户主目录下的 LoomEngine；Windows 用户可以自己选 D:\\ 之类。"""
        return os.path.join(os.path.expanduser("~"), "LoomEngine")

    def brief(self):
        with self._lock:
            return {
                "running": self._s["running"],
                "ok": self._s["ok"],
                "default_target": self.default_target(),
                "comfy_dir": self._s["comfy_dir"],
            }

    def status(self):
        with self._lock:
            steps = [dict(x) for x in self._s["steps"]]
            log = list(self._s["log"])[-300:]
            s = {k: v for k, v in self._s.items() if k not in ("steps", "log", "started", "finished")}
            started, finished = self._s["started"], self._s["finished"]
        s["steps"] = steps
        s["log"] = log
        s["elapsed"] = int(((finished or time.time()) - started)) if started else 0
        s["default_target"] = self.default_target()
        s["platform"] = sys.platform
        s["has_nvidia"] = bool(shutil.which("nvidia-smi"))
        return s

    # ---------- 日志 / 步骤 ----------
    def _emit(self, line):
        line = line.rstrip()
        if not line:
            return
        self._task_last = time.time()
        with self._lock:
            buf = self._s["log"]
            # pip 进度条会连续刷同一行，去个重避免日志被 %% 淹没
            if buf and buf[-1] == line:
                return
            buf.append(line)
            if len(buf) > self.MAX_LOG:
                del buf[: len(buf) - self.MAX_LOG]
        try:
            print("  [install] " + line)
        except Exception:
            pass

    def _begin(self, key):
        with self._lock:
            for st in self._s["steps"]:
                if st["key"] == key:
                    st["state"] = "running"

    def _end(self, key, state="done"):
        with self._lock:
            for st in self._s["steps"]:
                if st["key"] == key:
                    st["state"] = state

    # ---------- 子进程 ----------
    @staticmethod
    def _popen_kwargs():
        if os.name == "nt":
            return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
        return {"start_new_session": True}

    def _run(self, cmd, cwd=None, check=True, label="", timeout=None, env_extra=None):
        """跑一条命令，逐行（含 \\r）把输出回传到日志。timeout 秒到点强杀。"""
        shown = " ".join(cmd)
        self._emit("$ " + (shown if len(shown) < 400 else shown[:400] + " …"))
        env = os.environ.copy()
        # 不要把宿主机的 PYTHONPATH/PYTHONHOME 带进子进程：
        # 新建的 venv 会因此误加载别处的 sitecustomize / 第三方包，
        # 轻则 import 报错，重则在 pip 阶段直接卡死。
        for _k in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
            env.pop(_k, None)
        env["PYTHONUNBUFFERED"] = "1"
        env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if env_extra:
            env.update(env_extra)
        try:
            proc = subprocess.Popen(
                cmd, cwd=cwd, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0,
                **self._popen_kwargs()
            )
        except OSError as e:
            raise RuntimeError("无法执行 %s：%s" % (cmd[0], e))
        self._proc = proc
        killer = None
        if timeout:
            def _kill():
                try:
                    proc.kill()
                except Exception:
                    pass
            killer = threading.Timer(timeout, _kill)
            killer.daemon = True
            killer.start()

        # pip 装包的「Installing collected packages」阶段可以安静十几分钟，
        # 不打心跳的话用户会以为卡死，这里每 25 秒没输出就补一行。
        self._task_last = time.time()
        stop_hb = threading.Event()
        t0 = time.time()

        def _heartbeat():
            while not stop_hb.wait(8):
                idle = time.time() - getattr(self, "_task_last", t0)
                if idle >= 25:
                    self._emit("⏳ 还在跑…（本步已用 %ds，pip 装大包时可能好几分钟没输出）"
                               % int(time.time() - t0))

        hb = threading.Thread(target=_heartbeat, daemon=True)
        hb.start()
        buf = b""
        try:
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                buf += chunk
                parts = re.split(rb"[\r\n]", buf)
                buf = parts.pop()
                for raw in parts:
                    line = raw.decode("utf-8", "replace").strip()
                    if line:
                        self._emit(line)
            if buf.strip():
                self._emit(buf.decode("utf-8", "replace").strip())
        finally:
            code = proc.wait()
            stop_hb.set()
            if killer:
                killer.cancel()
            self._proc = None
        if timeout and code != 0 and code < 0:
            raise RuntimeError("%s超时（%ds）或被打断，改用下一种方式" % (label or "命令", timeout))
        if check and code != 0:
            raise RuntimeError("%s失败（exit %s），详见上方日志" % (label or "命令", code))
        return code

    def _capture(self, cmd, cwd=None):
        """跑一条命令只取输出（用于探测，不写日志）。"""
        env = os.environ.copy()
        for _k in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
            env.pop(_k, None)
        try:
            r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                               timeout=180, env=env, **self._popen_kwargs())
            return r.returncode, (r.stdout or "") + (r.stderr or "")
        except Exception as e:
            return 1, str(e)

    # ---------- 目录选择框 ----------
    def pick_dir(self, initial="", title="选择 ComfyUI 安装位置"):
        """弹系统原生文件夹选择框，返回绝对路径；用户取消返回空串。"""
        initial = os.path.abspath(os.path.expanduser(initial or "~"))
        try:
            if sys.platform == "darwin":
                esc_t = title.replace('"', ' ')
                script = (
                    'try\n'
                    '  set p to POSIX path of (choose folder with prompt "%s" default location POSIX file "%s")\n'
                    '  return p\n'
                    'on error number -128\n'
                    '  return ""\n'
                    'end try' % (esc_t, initial)
                )
                r = subprocess.run(["osascript", "-e", script], capture_output=True, timeout=600)
                out = r.stdout.decode("utf-8", "replace").strip()
                err = r.stderr.decode("utf-8", "replace").strip()
                if out:
                    return {"path": out.rstrip("/"), "canceled": False}
                if err and "-128" not in err:
                    # 常见：-1743 没给「自动化/文件夹访问」权限
                    return {"path": "", "canceled": True,
                            "error": "系统没允许打开选择框（%s）。可以手动在输入框里填路径。" % err.splitlines()[0][:120]}
                return {"path": "", "canceled": True}

            if os.name == "nt":
                # 路径结果写临时文件再读回：绕开中文路径在管道编码上的坑
                fd, outfile = tempfile.mkstemp(suffix=".txt", prefix="loom-pick-")
                os.close(fd)
                try:
                    def ps_q(s):
                        return s.replace("'", "''")

                    ps = (
                        "$ErrorActionPreference='Stop'\n"
                        "Add-Type -AssemblyName System.Windows.Forms | Out-Null\n"
                        "$f=New-Object System.Windows.Forms.FolderBrowserDialog\n"
                        "$f.Description='%s'\n"
                        "$f.ShowNewFolderButton=$true\n"
                        "$init='%s'\n"
                        "if (Test-Path -LiteralPath $init) { $f.SelectedPath=$init }\n"
                        "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {\n"
                        "  [IO.File]::WriteAllText('%s', $f.SelectedPath, (New-Object System.Text.UTF8Encoding $false))\n"
                        "}"
                    ) % (ps_q(title), ps_q(initial), ps_q(outfile))
                    subprocess.run(
                        ["powershell", "-NoProfile", "-STA", "-Command", ps],
                        capture_output=True, timeout=600, **self._popen_kwargs()
                    )
                    try:
                        with open(outfile, "r", encoding="utf-8-sig") as f:
                            out = f.read().strip()
                    except OSError:
                        out = ""
                    return {"path": out, "canceled": not out}
                finally:
                    try:
                        os.remove(outfile)
                    except OSError:
                        pass

            # Linux：zenity / kdialog / tkinter 依次尝试
            if shutil.which("zenity"):
                r = subprocess.run(["zenity", "--file-selection", "--directory",
                                    "--title=" + title, "--filename=" + initial + os.sep],
                                   capture_output=True, timeout=600)
                out = r.stdout.decode("utf-8", "replace").strip()
                return {"path": out, "canceled": not out}
            if shutil.which("kdialog"):
                r = subprocess.run(["kdialog", "--getexistingdirectory", initial, "--title", title],
                                   capture_output=True, timeout=600)
                out = r.stdout.decode("utf-8", "replace").strip()
                return {"path": out, "canceled": not out}
            code = (
                "import tkinter as tk\n"
                "from tkinter import filedialog\n"
                "r=tk.Tk(); r.withdraw(); r.attributes('-topmost',True)\n"
                "print(filedialog.askdirectory(initialdir=%r, title=%r) or '')\n" % (initial, title)
            )
            r = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=600)
            out = r.stdout.decode("utf-8", "replace").strip()
            return {"path": out, "canceled": not out}
        except Exception as e:
            return {"error": "打开目录选择框失败：%s" % e, "path": "", "canceled": True}

    # ---------- 开始 / 取消 ----------
    def start(self, opts):
        if self._s["running"]:
            return False, "正在安装中，等它跑完或先点取消"
        raw = (opts.get("target_dir") or "").strip()
        target = os.path.abspath(os.path.expanduser(raw or self.default_target()))
        torch = (opts.get("torch") or "auto").strip().lower()
        if torch not in ("auto", "cpu", "cu124", "cu126"):
            torch = "auto"
        mirror = opts.get("mirror", True)
        mirror = bool(mirror) if not isinstance(mirror, str) else mirror.lower() in ("1", "true", "yes", "on")
        with self._lock:
            self._reset()
            self._s.update({
                "running": True, "target": target, "torch": torch, "mirror": mirror,
                "started": time.time(),
            })
        threading.Thread(target=self._work, args=(target, torch, mirror), daemon=True).start()
        return True, "已开始安装到 " + target

    def cancel(self):
        proc = self._proc
        if not proc:
            return False, "当前没有正在执行的步骤"
        with self._lock:
            self._s["canceled"] = True
        try:
            proc.kill()
        except Exception:
            pass
        return True, "已终止当前步骤"

    # ---------- 主流程 ----------
    def _work(self, target, torch, mirror):
        comfy_dir = os.path.join(target, "ComfyUI")
        try:
            self._emit("安装目标：%s" % target)
            self._emit("平台：%s · Python %s" % (sys.platform, sys.version.split()[0]))
            self._emit("PyTorch 版本：%s · pip 源：%s" % (torch, "清华镜像" if mirror else "官方"))

            self._begin("prepare")
            os.makedirs(target, exist_ok=True)
            try:
                free = shutil.disk_usage(target).free / (1024 ** 3)
                self._emit("剩余空间：%.1f GB（建议 15 GB 以上）" % free)
                if free < 8:
                    self._emit("⚠️ 空间偏小，PyTorch + 模型很容易装不下")
            except OSError:
                pass
            self._end("prepare")

            self._begin("source")
            self._ensure_source(comfy_dir)
            self._end("source")

            self._begin("venv")
            py = self._ensure_venv(target, mirror)
            self._end("venv")

            self._begin("torch")
            self._ensure_torch(py, torch, mirror)
            self._end("torch")

            self._begin("deps")
            self._ensure_deps(py, comfy_dir, mirror)
            self._end("deps")

            self._begin("config")
            main_py = os.path.join(comfy_dir, "main.py")
            if not os.path.isfile(main_py):
                raise RuntimeError("装完了但 ComfyUI/main.py 不存在，目录可能不完整，请重试")
            ENGINE.set_cfg({"comfy_dir": comfy_dir})
            self._emit("已写入 .engine.json → comfy_dir=%s" % comfy_dir)
            code, out = self._capture([py, "-c",
                                       "import torch;print(torch.__version__, torch.cuda.is_available())"])
            self._emit("自检 torch：%s" % (out.strip() or code))
            self._end("config")

            with self._lock:
                self._s.update({"ok": True, "comfy_dir": comfy_dir, "finished": time.time()})
            self._emit("✅ 安装完成。回到设置点「启动引擎」即可出图。")
            self._emit("提示：出图还需要模型文件，放到 %s/models/ 下（或画布高级选项里挂外部目录）" % comfy_dir)
        except Exception as e:
            msg = str(e) or e.__class__.__name__
            canceled = bool(self._s.get("canceled"))
            with self._lock:
                for st in self._s["steps"]:
                    if st["state"] == "running":
                        st["state"] = "cancel" if canceled else "fail"
                self._s.update({"ok": False, "finished": time.time(),
                                "error": "已取消：下好的部分会保留，再点一次安装会接着用" if canceled else msg,
                                "comfy_dir": comfy_dir if os.path.isfile(os.path.join(comfy_dir, "main.py")) else ""})
            self._emit("■ 已取消安装" if canceled else "✕ 安装中断：" + msg)
        finally:
            with self._lock:
                self._s["running"] = False

    # ---------- 各步骤实现 ----------
    def _ensure_source(self, comfy_dir):
        if os.path.isfile(os.path.join(comfy_dir, "main.py")):
            self._emit("检测到已有 ComfyUI 源码，跳过下载：%s" % comfy_dir)
            self._end("source", "skip")
            return
        if shutil.which("git"):
            self._emit("方式一：git clone（浅克隆，240 秒没进展就换压缩包）")
            try:
                if os.path.isdir(comfy_dir) and not os.listdir(comfy_dir):
                    os.rmdir(comfy_dir)
                self._run(
                    ["git", "clone", "--depth", "1", self.COMFY_GIT, comfy_dir],
                    label="git clone ", timeout=240,
                    env_extra={
                        "GIT_TERMINAL_PROMPT": "0",
                        "GIT_HTTP_LOW_SPEED_LIMIT": "2000",
                        "GIT_HTTP_LOW_SPEED_TIME": "20",
                    },
                )
                if os.path.isfile(os.path.join(comfy_dir, "main.py")):
                    return
                self._emit("git clone 完成但没找到 main.py，改用压缩包")
            except Exception as e:
                self._emit("git clone 不可用（%s），改用压缩包下载" % e)
                shutil.rmtree(comfy_dir, ignore_errors=True)
        else:
            self._emit("没检测到 git，直接用压缩包下载")

        self._emit("方式二：codeload 压缩包（不依赖 git）")
        tmpdir = tempfile.mkdtemp(prefix="loom-comfy-")
        tgz = os.path.join(tmpdir, "ComfyUI.tar.gz")
        try:
            self._download(self.CODELOAD, tgz)
            self._emit("正在解压…")
            with tarfile.open(tgz, "r:gz") as tf:
                try:
                    tf.extractall(tmpdir, filter="data")
                except TypeError:  # Python < 3.12 没有 filter 参数
                    tf.extractall(tmpdir)
            roots = [d for d in os.listdir(tmpdir)
                     if os.path.isdir(os.path.join(tmpdir, d)) and d.lower().startswith("comfyui")]
            if not roots:
                raise RuntimeError("压缩包解压后没找到 ComfyUI 目录")
            src = os.path.join(tmpdir, roots[0])
            if os.path.isdir(comfy_dir):
                shutil.rmtree(comfy_dir, ignore_errors=True)
            shutil.move(src, comfy_dir)
            self._emit("源码就位：%s" % comfy_dir)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        if not os.path.isfile(os.path.join(comfy_dir, "main.py")):
            raise RuntimeError("源码目录里没有 main.py，下载可能不完整")

    def _download(self, url, dest):
        self._emit("下载 " + url)
        req = urllib.request.Request(url, headers={"User-Agent": "Loom-Installer/1.0"})
        last = -10
        with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    pct = int(got * 100 / total)
                    if pct >= last + 10:
                        last = pct
                        self._emit("  %d%%  %.1f / %.1f MB" % (pct, got / 1048576, total / 1048576))
        self._emit("下载完成：%.1f MB" % (os.path.getsize(dest) / 1048576))

    # ---------- 挑一个够新的解释器 ----------
    # ComfyUI 现在要求 Python >= 3.10（源码里大量 `X | None`）。
    # macOS 自带的 /usr/bin/python3 是 3.9，拿它建 venv 会导致引擎一启动就
    # TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'。
    MIN_PY = (3, 10)
    PY_NAMES = ("python3.13", "python3.12", "python3.11", "python3.10")

    @staticmethod
    def _py_ver(exe):
        try:
            _env = os.environ.copy()
            for _k in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
                _env.pop(_k, None)
            r = subprocess.run(
                [exe, "-c", "import sys;print('%d.%d'%sys.version_info[:2])"],
                capture_output=True, text=True, timeout=25, env=_env,
                stdin=subprocess.DEVNULL, **Installer._popen_kwargs()
            )
            if r.returncode == 0 and r.stdout.strip():
                a, b = r.stdout.strip().split(".")
                return (int(a), int(b))
        except Exception:
            pass
        return (0, 0)

    def _interpreter_candidates(self):
        import glob
        cands = [sys.executable]
        for n in self.PY_NAMES:
            p = shutil.which(n)
            if p:
                cands.append(p)
        if sys.platform == "darwin":
            for pat in ("/opt/homebrew/bin/python3.*",
                        "/usr/local/bin/python3.*",
                        "/opt/homebrew/opt/python@3.*/bin/python3.*",
                        "/Library/Frameworks/Python.framework/Versions/3.*/bin/python3"):
                cands.extend(sorted(glob.glob(pat), reverse=True))
        elif os.name == "nt":
            for base in (os.environ.get("LOCALAPPDATA", ""), "C:\\"):
                if base:
                    cands.extend(sorted(glob.glob(os.path.join(
                        base, "Programs", "Python", "Python3*", "python.exe")), reverse=True))
                    cands.extend(sorted(glob.glob(os.path.join(base, "Python3*", "python.exe")), reverse=True))
            if shutil.which("py"):
                for v in ("3.13", "3.12", "3.11", "3.10"):
                    try:
                        r = subprocess.run(["py", "-" + v, "-c", "import sys;print(sys.executable)"],
                                           capture_output=True, text=True, timeout=25,
                                           **self._popen_kwargs())
                        if r.returncode == 0 and r.stdout.strip():
                            cands.append(r.stdout.strip())
                    except Exception:
                        pass
        else:
            cands.extend(sorted(glob.glob("/usr/bin/python3.*"), reverse=True))
        seen, out = set(), []
        for c in cands:
            if c and c not in seen:
                seen.add(c)
                out.append(c)
        return out

    def _pick_interpreter(self):
        """返回 (exe, (major, minor))；都太旧时，装了 Homebrew 就自动装 3.12。"""
        cands = self._interpreter_candidates()
        for c in cands:
            if not (os.path.isfile(c) or shutil.which(c)):
                continue
            v = self._py_ver(c)
            if v >= self.MIN_PY:
                return c, v

        shown = []
        for c in cands[:4]:
            v = self._py_ver(c)
            shown.append("%s(%d.%d)" % (os.path.basename(c), v[0], v[1]))
        self._emit("本机 Python：%s，都不满足 %d.%d+"
                   % ("、".join(shown) or "无", self.MIN_PY[0], self.MIN_PY[1]))

        if shutil.which("brew"):
            self._emit("用 Homebrew 自动装 Python 3.12（约 30 MB，几分钟，可能要求输密码）…")
            try:
                self._run(["brew", "install", "python@3.12"], label="安装 Python 3.12 ")
            except Exception as e:
                self._emit("brew 安装失败：%s" % str(e)[:150])
            for c in ("/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12",
                      "/opt/homebrew/opt/python@3.12/bin/python3.12",
                      shutil.which("python3.12") or ""):
                if c and os.path.isfile(c):
                    v = self._py_ver(c)
                    if v >= self.MIN_PY:
                        return c, v
        return None, (0, 0)

    @staticmethod
    def _venv_python(target):
        if os.name == "nt":
            return os.path.join(target, "venv", "Scripts", "python.exe")
        return os.path.join(target, "venv", "bin", "python3")

    def _ensure_venv(self, target, mirror):
        py = self._venv_python(target)
        if os.path.isfile(py):
            v = self._py_ver(py)
            if v >= self.MIN_PY:
                self._emit("已有独立环境（Python %d.%d），跳过创建：%s" % (v[0], v[1], py))
                self._end("venv", "skip")
                return self._pip_upgrade(py, mirror)
            self._emit("⚠️ 旧环境是 Python %d.%d，ComfyUI 要求 %d.%d+，改名为 venv-old 后重建"
                       % (v[0], v[1], self.MIN_PY[0], self.MIN_PY[1]))
            self._retire_venv(target)

        interp, ver = self._pick_interpreter()
        if not interp:
            raise RuntimeError(
                "没找到 Python %d.%d+ 的解释器（ComfyUI 硬要求；用 3.9 会直接报 "
                "TypeError: unsupported operand type(s) for |）。"
                "macOS 可执行 brew install python@3.12；Windows 去 python.org 装 3.12+ 后重试。"
                % (self.MIN_PY[0], self.MIN_PY[1]))
        self._emit("用 Python %d.%d 创建虚拟环境：%s" % (ver[0], ver[1], interp))
        self._run([interp, "-m", "venv", os.path.join(target, "venv")], label="创建虚拟环境")
        if not os.path.isfile(py):
            raise RuntimeError("虚拟环境创建后找不到 python：%s" % py)
        return self._pip_upgrade(py, mirror)

    @staticmethod
    def _retire_venv(target):
        """把旧 venv 改名留档，而不是 rm -rf：
        1) 不用逐个删几千个文件（慢，Windows 上还会被占用的 dll 卡住）；
        2) 万一新版装失败，旧环境还在，可以手动改回来。
        """
        old = os.path.join(target, "venv")
        if not os.path.isdir(old):
            return
        bak = os.path.join(target, "venv-old")
        if os.path.isdir(bak):
            bak = os.path.join(target, "venv-old-%s" % time.strftime("%Y%m%d-%H%M%S"))
        try:
            os.replace(old, bak)
        except OSError:
            # 改名失败（跨盘/被占用/权限）就直接删，别用 shutil.move 复制几个 GB
            shutil.rmtree(old, ignore_errors=True)

    def _pip_upgrade(self, py, mirror):
        # 升级 pip：失败不致命（老 pip 也能装，只是慢）
        cmd = [py, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]
        if mirror:
            cmd += ["-i", self.PYPI_MIRROR]
        try:
            self._run(cmd, label="升级 pip ")
        except Exception as e:
            self._emit("pip 升级失败（不影响继续）：%s" % e)
        return py

    def _torch_flavor(self, flavor):
        if flavor != "auto":
            return flavor
        if sys.platform == "darwin":
            return "pypi"
        if shutil.which("nvidia-smi"):
            return "cu124"
        return "cpu"

    def _ensure_torch(self, py, flavor, mirror):
        code, out = self._capture([py, "-c", "import torch;print(torch.__version__)"])
        if code == 0:
            self._emit("当前环境已有 PyTorch %s，跳过安装" % out.strip())
            self._emit("（想换 CUDA 版本：删掉 venv 目录后重装，或选指定版本再装一次）")
            self._end("torch", "skip")
            return
        real = self._torch_flavor(flavor)
        cmd = [py, "-m", "pip", "install", "torch", "torchvision", "torchaudio"]
        if real in self.TORCH_INDEX:
            cmd += ["--index-url", self.TORCH_INDEX[real]]
            self._emit("PyTorch 来源：%s（%s）" % (self.TORCH_INDEX[real], real))
        else:
            if mirror:
                cmd += ["-i", self.PYPI_MIRROR]
            self._emit("PyTorch 来源：PyPI（Apple Silicon 走 MPS，最新版）")
        self._emit("首次下载约 200 MB ~ 2.5 GB，按网速可能要 5~30 分钟…")
        try:
            self._run(cmd, label="安装 PyTorch ")
        except Exception as e:
            if real not in self.TORCH_INDEX:
                raise
            self._emit("PyTorch 指定源装不下来（%s），退回默认源再试一次（可能装成 CPU 版）" % str(e)[:110])
            fallback = [py, "-m", "pip", "install", "torch", "torchvision"]
            if mirror:
                fallback += ["-i", self.PYPI_MIRROR]
            self._run(fallback, label="安装 PyTorch（兜底） ")

    def _pip_install(self, py, args, cwd=None, label="安装依赖 ", mirror=False):
        """优先走镜像；镜像缺包（新发布的包常常滞后）就自动退回官方 PyPI。"""
        base = [py, "-m", "pip", "install"] + list(args)
        if mirror:
            try:
                self._run(base + ["-i", self.PYPI_MIRROR], cwd=cwd, label=label + "(镜像) ")
                return
            except Exception as e:
                self._emit("镜像源装不下来（%s），自动改走官方 PyPI 重试…" % str(e)[:110])
        self._run(base, cwd=cwd, label=label)

    def _ensure_deps(self, py, comfy_dir, mirror):
        req = os.path.join(comfy_dir, "requirements.txt")
        if not os.path.isfile(req):
            self._emit("没找到 requirements.txt，跳过")
            self._end("deps", "skip")
            return
        self._pip_install(py, ["-r", req], cwd=comfy_dir, label="安装 ComfyUI 依赖 ", mirror=mirror)


INSTALLER = Installer()

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
            st = ENGINE.status()
            st["install"] = INSTALLER.brief()
            return self._engine_json(st)

        if path == "/engine/install/status":
            return self._engine_json(INSTALLER.status())

        if path == "/engine/install/start":
            ok, msg = INSTALLER.start(body or {})
            return self._engine_json({"ok": ok, "message": msg, **INSTALLER.status()},
                                     status=200 if ok else 409)

        if path == "/engine/install/cancel":
            ok, msg = INSTALLER.cancel()
            return self._engine_json({"ok": ok, "message": msg, **INSTALLER.status()})

        if path == "/engine/pick-dir":
            return self._engine_json(INSTALLER.pick_dir(
                (body or {}).get("initial", ""),
                (body or {}).get("title", "选择 ComfyUI 安装位置"),
            ))

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

        if path == "/engine/outputs":
            return self._engine_json(ENGINE.outputs(int(body.get("limit", 60)) if body else 60))

        if path == "/engine/scan-models":
            return self._engine_json(ENGINE.scan_models())

        if path == "/engine/sys":
            return self._engine_json(ENGINE.sys())

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
