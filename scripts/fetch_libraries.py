#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把三个姊妹素材库抓取/转换进 Loom 的 reference/：

    动画服装  AI-Costume-Anime-Resource-Library   （1320 张，8 类）
    角色组装  Character-Assembly-Database          （1027 张，发型/服装/姿势）
    姿势深度  AI-Pose-Depth-Resource-Library       （1439 张，288 组 / 5 视角）

脚本做四件事：
1. 拉取三份元数据（costume/data.zh.json、assembly/data.js、pose-depth/data/pose-depth-zh.json）
2. 统一成 Loom 的参考库格式，写到 reference/costume.json / assembly.json / pose-depth.json
3. 下载缩略图到 reference/costume/、reference/assembly/、reference/pose-depth/
4. 生成 reference/data-extra.js（file:// 双击时也能浏览）

用法：
    python3 scripts/fetch_libraries.py
    python3 scripts/fetch_libraries.py --meta-only   # 只转数据，不下载图

图片版权归各原站作者，仅供个人创作参考；禁止再分发、转售图片数据本身。
"""

import json
import os
import re
import socket
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# 国内网络里 IPv6 的 TLS 握手经常超时，强制走 IPv4 更稳（curl 默认会回退，urllib 不会）
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _ipv4_only

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "reference")

RAW = "https://raw.githubusercontent.com/{repo}/main/{path}"
CDN_HOSTS = ["cdn.jsdelivr.net", "gcore.jsdelivr.net", "fastly.jsdelivr.net"]

SOURCES = {
    "costume": {
        "repo": "Atom-kkk/AI-Costume-Anime-Resource-Library",
        "pages": "https://atom-kkk.github.io/AI-Costume-Anime-Resource-Library/",
        "meta": "data.zh.json",
        "thumb": "thumbs/{id}.webp",
        "dir": "costume",
        "json": "costume.json",
        "ext": ".webp",
        "magic": b"RIFF",
    },
    "assembly": {
        "repo": "Atom-kkk/Character-Assembly-Database",
        "pages": "https://atom-kkk.github.io/Character-Assembly-Database/",
        "meta": "data.js",
        "thumb": "thumb/{id}.webp",
        "dir": "assembly",
        "json": "assembly.json",
        "ext": ".webp",
        "magic": b"RIFF",
    },
    "poseDepth": {
        "repo": "Atom-kkk/AI-Pose-Depth-Resource-Library",
        "pages": "https://atom-kkk.github.io/AI-Pose-Depth-Resource-Library/",
        "meta": "data/pose-depth-zh.json",
        "thumb": "thumbs/{id}.jpg",
        "dir": "pose-depth",
        "json": "pose-depth.json",
        "ext": ".jpg",
        "magic": b"\xff\xd8\xff",
    },
}


def fetch_text(urls):
    last = None
    for attempt in range(3):
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                    "Accept": "application/json,text/plain,*/*",
                })
                with urllib.request.urlopen(req, timeout=40) as r:
                    return r.read().decode("utf-8")
            except Exception as e:
                last = e
        time.sleep(0.6 * (attempt + 1))
    raise last


def ordered_unique(values):
    seen, out = set(), []
    for v in values:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def normalize_costume(raw):
    items = []
    for it in raw.get("items", []):
        kw_en = ", ".join(it.get("keywordsEn") or [])
        kw_zh = " ".join(it.get("keywords") or [])
        items.append({
            "id": it["id"],
            "cat": it.get("category", ""),
            "categoryJa": it.get("categoryJa", ""),
            "kw": kw_en,
            "kwZh": kw_zh,
            "thumb": "reference/costume/%s.webp" % it["id"],
            "image": it.get("image", ""),
            "original": it.get("original", ""),
        })
    return {
        "count": len(items),
        "categories": ordered_unique([i["cat"] for i in items if i["cat"]]),
        "source": "COSTUME-ANIME-DB · 衣装集 アニメ版 · 图 ギア（@giaaibusi）",
        "items": items,
    }


def normalize_assembly(raw):
    items = []
    for it in raw.get("items", []):
        set_name = it.get("set", "")
        item_id = it["id"]
        # 姿势条目用 -s 后缀表示侧面版；拆出统一编号与视角，方便组合台复用
        if set_name == "pose":
            code = item_id[:-2] if item_id.endswith("-s") else item_id
            angle = "侧面" if item_id.endswith("-s") else "正面"
        else:
            code, angle = "", ""
        items.append({
            "id": item_id,
            "set": set_name,
            "cat": it.get("cat", ""),
            "cj": it.get("cj", ""),
            "jp": it.get("jp", ""),
            "zh": it.get("zh", ""),
            "name": it.get("zh", ""),
            "tags": it.get("tags", ""),
            "kw": it.get("tags", ""),
            "sub": it.get("sub", ""),
            "parent": it.get("parent", ""),
            "line": int(it.get("line") or 0),
            "code": code,
            "angle": angle,
            "thumb": "reference/assembly/%s.webp" % item_id,
        })
    set_labels = {"hair": "发型", "outfit": "服装", "pose": "姿势"}
    cats = {k: ordered_unique([i["cat"] for i in items if i["set"] == k and i["cat"]])
            for k in ("hair", "outfit", "pose")}
    item_counts = {k: sum(1 for i in items if i["set"] == k) for k in ("hair", "outfit", "pose")}
    orig = raw.get("counts") or {}
    return {
        "count": len(items),
        "sets": item_counts,
        "groups": {"hair": orig.get("hair", item_counts["hair"]),
                   "outfit": orig.get("outfit", item_counts["outfit"]),
                   "pose": orig.get("pose", item_counts["pose"])},
        "setLabels": set_labels,
        "categories": cats,
        "source": "Character-Assembly-Database · 角色组装素材库 · 整理/汉化 Atom-kkk",
        "items": items,
    }


def normalize_pose_depth(raw):
    items = []
    for it in raw:
        items.append({
            "id": it["id"],
            "code": it.get("姿势编号", ""),
            "cat": it.get("体系", ""),
            "cls": it.get("分类", ""),
            "name": it.get("姿势名称", ""),
            "angle": it.get("角度", ""),
            "thumb": "reference/pose-depth/%s.jpg" % it["id"],
            "w": 900,
            "h": 1200,
        })
    return {
        "count": len(items),
        "groups": len({(i["code"], i["cat"]) for i in items}),
        "systems": ordered_unique([i["cat"] for i in items if i["cat"]]),
        "classes": ordered_unique([i["cls"] for i in items if i["cls"]]),
        "angles": ["正面", "侧面", "斜侧", "俯视", "仰视"],
        "source": "POSE Atlas depth 分册 · 图 ギア（@giaaibusi）",
        "items": items,
    }


def load_meta(kind):
    cfg = SOURCES[kind]
    urls = [cfg["pages"] + cfg["meta"], RAW.format(repo=cfg["repo"], path=cfg["meta"])]
    urls += ["https://%s/gh/%s@main/%s" % (host, cfg["repo"], cfg["meta"]) for host in CDN_HOSTS]
    text = fetch_text(urls)
    if kind == "assembly":
        m = re.search(r"window\.DB\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
        if not m:
            raise ValueError("无法从 data.js 里提取 window.DB")
        return json.loads(m.group(1))
    return json.loads(text)


def download_one(kind, item_id, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 800:
        return "skip"
    cfg = SOURCES[kind]
    path = cfg["thumb"].format(id=urllib.parse.quote(item_id, safe=""))
    urls = [cfg["pages"] + path, RAW.format(repo=cfg["repo"], path=path)]
    urls += ["https://%s/gh/%s@main/%s" % (host, cfg["repo"], path) for host in CDN_HOSTS]
    last = None
    for attempt, url in enumerate(urls):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Accept": "image/*,*/*",
            })
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if len(data) < 800 or data[:len(cfg["magic"])] != cfg["magic"]:
                raise ValueError("bad payload %d bytes" % len(data))
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            return "ok"
        except Exception as e:
            last = e
            time.sleep(0.3 * (attempt + 1))
    return "fail:%s" % last


def main():
    meta_only = "--meta-only" in sys.argv
    os.makedirs(REF, exist_ok=True)

    normalized = {}
    for kind in ("costume", "assembly", "poseDepth"):
        print("拉取元数据：%s …" % kind, end="", flush=True)
        raw = load_meta(kind)
        if kind == "costume":
            data = normalize_costume(raw)
        elif kind == "assembly":
            data = normalize_assembly(raw)
        else:
            data = normalize_pose_depth(raw)
        normalized[kind] = data
        out = os.path.join(REF, SOURCES[kind]["json"])
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        print(" %d 条 -> reference/%s" % (len(data["items"]), SOURCES[kind]["json"]))

    extra_path = os.path.join(REF, "data-extra.js")
    with open(extra_path, "w", encoding="utf-8") as f:
        f.write("/* 自动生成：由 scripts/fetch_libraries.py 写入，供 file:// 直接打开时使用 */\n")
        f.write("window.REF_DATA_EXTRA = ")
        json.dump(normalized, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("内联数据 -> reference/data-extra.js")

    if meta_only:
        print("只转数据，跳过图片下载。")
        return 0

    tasks = []
    for kind, data in normalized.items():
        cfg = SOURCES[kind]
        out_dir = os.path.join(REF, cfg["dir"])
        os.makedirs(out_dir, exist_ok=True)
        for it in data["items"]:
            tasks.append((kind, it["id"], os.path.join(out_dir, it["id"] + cfg["ext"])))

    total = len(tasks)
    print("共 %d 张缩略图，开始下载…" % total)
    stats = {"ok": 0, "skip": 0, "fail": 0}
    fails = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=24) as ex:
        futures = {ex.submit(download_one, k, i, d): (k, i, d) for k, i, d in tasks}
        for n, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            if r == "ok":
                stats["ok"] += 1
            elif r == "skip":
                stats["skip"] += 1
            else:
                stats["fail"] += 1
                fails.append((futures[fut], r))
            if n % 200 == 0 or n == total:
                print("  %d/%d  ok=%d skip=%d fail=%d  %.0fs" % (
                    n, total, stats["ok"], stats["skip"], stats["fail"], time.time() - t0))

    print("\n完成：ok=%d skip=%d fail=%d  用时 %.0fs" % (
        stats["ok"], stats["skip"], stats["fail"], time.time() - t0))
    if fails:
        print("失败 %d 张，重跑一次会自动补齐：" % len(fails))
        for (kind, item_id, _), err in fails[:8]:
            print("  %s/%s  %s" % (kind, item_id, err))
    return 0


if __name__ == "__main__":
    sys.exit(main())
