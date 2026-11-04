"""六个内置参考图库的数据完整性测试。

覆盖「图库随仓库分发」这条承诺：
  · 六份 JSON 都在、条数对得上
  · 每一条记录的缩略图都真实存在，且不是 0 字节 / 半截文件
  · file:// 用的两份内联数据都在

运行：
    python3 -m unittest discover -s tests/py -v
    或 pytest tests/py -q
"""

import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REF = os.path.join(ROOT, "reference")

LIBRARIES = {
    "outfits": {"json": "outfits.json", "count": 1407},
    "faces": {"json": "faces.json", "count": 1499},
    "poses": {"json": "poses.json", "count": 1439},
    "costume": {"json": "costume.json", "count": 1320},
    "assembly": {"json": "assembly.json", "count": 1027},
    "poseDepth": {"json": "pose-depth.json", "count": 1439},
}


def read_json(name):
    with open(os.path.join(REF, name), encoding="utf-8") as f:
        return json.load(f)


class ReferenceDataTest(unittest.TestCase):
    def test_six_json_files_and_counts(self):
        total = 0
        for kind, cfg in LIBRARIES.items():
            path = os.path.join(REF, cfg["json"])
            self.assertTrue(os.path.exists(path), f"{kind} 缺少 {cfg['json']}")
            data = read_json(cfg["json"])
            self.assertEqual(data.get("count"), cfg["count"], f"{kind} 条数不对")
            self.assertEqual(len(data.get("items", [])), cfg["count"], f"{kind} items 长度不对")
            total += cfg["count"]
        self.assertEqual(total, 8131, "六库总数应为 8131")

    def test_every_thumbnail_exists(self):
        missing = []
        empty = []
        for kind, cfg in LIBRARIES.items():
            data = read_json(cfg["json"])
            for it in data["items"]:
                thumb = (it.get("thumb") or "").split("?")[0]
                path = os.path.join(ROOT, thumb)
                if not thumb or not os.path.exists(path):
                    missing.append(f"{kind}:{it.get('id')} -> {thumb}")
                elif os.path.getsize(path) < 800:
                    empty.append(f"{kind}:{it.get('id')} -> {thumb}")
        self.assertEqual(missing, [], "有缩略图缺失：" + ", ".join(missing[:5]))
        self.assertEqual(empty, [], "有缩略图过小：" + ", ".join(empty[:5]))

    def test_inline_data_for_file_protocol(self):
        data_js = os.path.join(REF, "data.js")
        extra_js = os.path.join(REF, "data-extra.js")
        self.assertTrue(os.path.exists(data_js), "缺少 reference/data.js")
        self.assertTrue(os.path.exists(extra_js), "缺少 reference/data-extra.js")
        with open(extra_js, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("window.REF_DATA_EXTRA", text)
        for kind in ("costume", "assembly", "poseDepth"):
            self.assertIn(f'"{kind}"', text, f"data-extra.js 缺少 {kind}")


if __name__ == "__main__":
    unittest.main()
