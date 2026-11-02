#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 gcore.jsdelivr.net 单一节点拉取 loom-vault 三个参考图库的缩略图。

原版 scripts/fetch_reference.py 轮换 cdn/gcore/fastly，但本机环境下
cdn 与 fastly 会 301 跳转到 raw.githubusercontent.com（不可达），
只有 gcore 直出 200，所以这里固定 gcore 并绕过系统代理。
"""

import json
import os
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = "/Users/apple/WorkBuddy/2026-11-02-14-04-26/loom-vault"
HOST = "gcore.jsdelivr.net"

# name -> (repo_path, remote_dir, ext, magic)
JOBS = [
    ("outfits", "Atom-kkk/AI-Clothing-Resource-Library@main", "assets/thumbs", ".webp", b"RIFF"),
    ("faces", "Atom-kkk/AI-Face-Resource-Library@main", "assets/thumb", ".webp", b"RIFF"),
    ("poses", "Atom-kkk/AI-Pose-Resource-Library@main", "thumbs", ".jpg", b"\xff\xd8\xff"),
]

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
lock = threading.Lock()
stat = {"ok": 0, "skip": 0, "fail": 0}
fails = []


def fetch_one(name, repo, rdir, ext, magic, item_id, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 800:
        with lock:
            stat["skip"] += 1
        return
    url = "https://%s/gh/%s/%s/%s%s" % (HOST, repo, rdir, item_id, ext)
    last = None
    for _ in range(4):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Accept": "image/*,*/*",
            })
            with OPENER.open(req, timeout=30) as r:
                data = r.read()
            if len(data) < 800 or data[:len(magic)] != magic:
                raise ValueError("bad payload %d bytes" % len(data))
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            with lock:
                stat["ok"] += 1
            return
        except Exception as e:  # noqa: BLE001
            last = e
    with lock:
        stat["fail"] += 1
        fails.append((item_id, str(last)))


def main(only=None):
    total_done = 0
    for name, repo, rdir, ext, magic in JOBS:
        if only and name != only:
            continue
        data = json.load(open(os.path.join(ROOT, "reference", name + ".json"), encoding="utf-8"))
        items = data["items"] if isinstance(data, dict) else data
        outdir = os.path.join(ROOT, "reference", name)
        os.makedirs(outdir, exist_ok=True)
        before = {k: v for k, v in stat.items()}
        tasks = []
        for it in items:
            tasks.append((it["id"], os.path.join(outdir, it["id"] + ext)))
        with ThreadPoolExecutor(max_workers=16) as ex:
            futs = [ex.submit(fetch_one, name, repo, rdir, ext, magic, i, d) for i, d in tasks]
            for i, _ in enumerate(as_completed(futs), 1):
                if i % 200 == 0 or i == len(futs):
                    print("  %s %d/%d  ok=%d skip=%d fail=%d"
                          % (name, i, len(futs), stat["ok"], stat["skip"], stat["fail"]), flush=True)
        print("[%s] 完成 ok=%d skip=%d fail=%d"
              % (name, stat["ok"] - before["ok"], stat["skip"] - before["skip"], stat["fail"] - before["fail"]), flush=True)
        total_done += len(tasks)

    print("=== 合计 %d 张，ok=%d skip=%d fail=%d ===" % (total_done, stat["ok"], stat["skip"], stat["fail"]))
    if fails:
        print("失败样例：", fails[:10])
        with open("/tmp/fetch_ref_fails.txt", "w") as f:
            for i, e in fails:
                f.write("%s\t%s\n" % (i, e))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
