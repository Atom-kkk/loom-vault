#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
拉取三个参考图库的缩略图到 reference/ 目录。

仓库里只提交了元数据（reference/*.json 与 data.js），图片没有入库。
克隆后跑一次这个脚本，参考图库就能本地可用：

    python3 scripts/fetch_reference.py

特性：
- 幂等：已存在且体积正常的文件会跳过，中断后重跑即可续传
- 多 CDN 轮换：cdn / gcore / fastly 三个 jsdelivr 节点，失败自动换
- 8 线程并发，约 15~25 分钟拉完 4345 张

来源：
  服饰 AI-Clothing-Resource-Library · 衣装集 COSTUME-DB-01 · 图 ギア（@giaaibusi）
  人脸 AI-Face-Resource-Library   · AIモデル顔データベース   · 图 ギア / あぎ（@agi_aibusi）· CC0
  姿势 AI-Pose-Resource-Library   · POSE Atlas · 图 ギア
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
    ("outfits", "Atom-kkk/AI-Clothing-Resource-Library@main/assets/thumbs", "reference/outfits.json", ".webp", b"RIFF"),
    ("faces", "Atom-kkk/AI-Face-Resource-Library@main/assets/thumb", "reference/faces.json", ".webp", b"RIFF"),
    ("poses", "Atom-kkk/AI-Pose-Resource-Library@main/thumbs", "reference/poses.json", ".jpg", b"\xff\xd8\xff"),
]

done = {"ok": 0, "skip": 0, "fail": 0}
fails = []


def fetch(url_path, dest, ext, magic):
    if os.path.exists(dest) and os.path.getsize(dest) > 800:
        return "skip"

    last = None
    for attempt in range(4):
        host = HOSTS[(hash(url_path) + attempt) % len(HOSTS)]
        url = "https://%s/gh/%s%s" % (host, url_path, ext)
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Accept": "image/*,*/*",
            })
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if len(data) < 800 or data[:len(magic)] != magic:
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
    for kind, remote, meta, ext, magic in JOBS:
        meta_path = os.path.join(ROOT, meta)
        if not os.path.exists(meta_path):
            print("✕ 找不到 %s" % meta)
            return 1
        data = json.load(open(meta_path, encoding="utf-8"))
        out_dir = os.path.join(ROOT, "reference", kind)
        os.makedirs(out_dir, exist_ok=True)
        for it in data["items"]:
            # 姿势库的缩略图文件名就是 id（含扩展名在 it["thumb"] 里，去掉目录与扩展名即 id）
            thumb_id = it.get("thumb", "").rsplit("/", 1)[-1]
            thumb_id = thumb_id.rsplit(".", 1)[0] if "." in thumb_id else thumb_id
            tasks.append(("%s/%s" % (remote, thumb_id), os.path.join(out_dir, thumb_id + ext), ext, magic))

    total = len(tasks)
    print("共 %d 张缩略图，开始下载…" % total)
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(fetch, p, d, e, m): (p, d) for p, d, e, m in tasks}
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
