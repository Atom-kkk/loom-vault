#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
拉取两个参考图库的缩略图到 reference/ 目录。

仓库里只提交了元数据（reference/*.json），图片有 42 MB 没有入库。
克隆后跑一次这个脚本，参考图库就能本地可用：

    python3 scripts/fetch_reference.py

特性：
- 幂等：已存在且体积正常的文件会跳过，中断后重跑即可续传
- 多 CDN 轮换：cdn / gcore / fastly 三个 jsdelivr 节点，失败自动换
- 8 线程并发，约 10~20 分钟拉完 2906 张

来源：
  服饰 AI-Clothing-Resource-Library · 衣装集 COSTUME-DB-01 · 图 ギア（@giaaibusi）
  人脸 AI-Face-Resource-Library   · AIモデル顔データベース   · 图 ギア / あぎ（@agi_aibusi）· CC0
图片版权归原作者，仅供个人创作参考，禁止再分发图片数据本身。
"""

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOSTS = ["cdn.jsdelivr.net", "gcore.jsdelivr.net", "fastly.jsdelivr.net"]

JOBS = [
    ("outfits", "Atom-kkk/AI-Clothing-Resource-Library@main/assets/thumbs", "reference/outfits.json"),
    ("faces", "Atom-kkk/AI-Face-Resource-Library@main/assets/thumb", "reference/faces.json"),
]

done = {"ok": 0, "skip": 0, "fail": 0}
fails = []


def fetch(url_path, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 800:
        return "skip"

    last = None
    for attempt in range(4):
        host = HOSTS[(hash(url_path) + attempt) % len(HOSTS)]
        url = "https://%s/gh/%s.webp" % (host, url_path)
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Accept": "image/webp,*/*",
            })
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if len(data) < 800 or data[:4] != b"RIFF":
                raise ValueError("bad payload %d bytes" % len(data))
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            return "ok"
        except Exception as e:
            last = e
            time.sleep(0.4 * (attempt + 1))

    fails.append((url_path, str(last)))
    return "fail"


def main():
    tasks = []
    for kind, remote, meta in JOBS:
        meta_path = os.path.join(ROOT, meta)
        if not os.path.exists(meta_path):
            print("✕ 找不到 %s" % meta)
            return 1
        data = json.load(open(meta_path, encoding="utf-8"))
        out_dir = os.path.join(ROOT, "reference", kind)
        os.makedirs(out_dir, exist_ok=True)
        for it in data["items"]:
            tasks.append(("%s/%s" % (remote, it["id"]), os.path.join(out_dir, it["id"] + ".webp")))

    total = len(tasks)
    print("共 %d 张缩略图，开始下载…" % total)
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(fetch, p, d): (p, d) for p, d in tasks}
        for i, fut in enumerate(as_completed(futures), 1):
            done[fut.result()] += 1
            if i % 200 == 0 or i == total:
                print("  %d/%d  ok=%d skip=%d fail=%d  %.0fs" % (
                    i, total, done["ok"], done["skip"], done["fail"], time.time() - t0))

    print("\n完成：ok=%d skip=%d fail=%d  用时 %.0fs" % (
        done["ok"], done["skip"], done["fail"], time.time() - t0))

    if fails:
        print("失败 %d 张，重跑一次会自动补齐。" % len(fails))
        for p, e in fails[:5]:
            print("  ", p, e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
