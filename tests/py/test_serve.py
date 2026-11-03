"""serve.py 的回归测试。

重点覆盖「出过 bug」和「平台相关」的部分：
  · 模型目录扫描（真实模型 / 占位文件 / 下载中）
  · extra_model_paths.yaml 的格式（曾经多套一层直接把 ComfyUI 搞崩）
  · 端口 → 进程 的识别（Windows 没有 lsof，曾经静默失效）
  · restart 的安全判据（曾经按过期 pid 盲杀，把 serve.py 自己杀了）

运行：
    python3 -m unittest discover -s tests/py -v
    或 pytest tests/py -q
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import serve  # noqa: E402


class EngineFixture(unittest.TestCase):
    """每个用例一个干净的 Engine（不读也不写真实的 .engine.json）"""

    def setUp(self):
        self.engine = serve.Engine.__new__(serve.Engine)   # 跳过 __init__ 的文件读取
        self.engine._state = {}

    def tearDown(self):
        pass


# ============================================================
# 目录类型 / 文件计数
# ============================================================
class TestDirMapping(unittest.TestCase):

    def test_aliases(self):
        cases = {
            'checkpoints': 'checkpoints',
            'Checkpoints': 'checkpoints',
            'stable-diffusion': 'checkpoints',
            'diffusion_models': 'diffusion_models',
            'unet': 'diffusion_models',
            'lora': 'loras',
            'text_encoders': 'text_encoders',
            't5': 'text_encoders',
            'clip_vision': 'clip_vision',
            'upscalers': 'upscale_models',
        }
        for name, expect in cases.items():
            self.assertEqual(serve.Engine._type_of_dir(name), expect, name)

    def test_unknown_dir(self):
        self.assertEqual(serve.Engine._type_of_dir('my_stuff'), '')
        self.assertEqual(serve.Engine._type_of_dir('__pycache__'), '')


class TestCountModels(EngineFixture):

    def _touch(self, d, name, size=10):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), 'wb') as f:
            f.write(b'x' * size)

    def test_counts_real_models_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._touch(tmp, 'a.safetensors')
            self._touch(tmp, 'b.ckpt')
            self._touch(tmp, 'put_checkpoints_here')       # ComfyUI 的占位文件
            self._touch(tmp, 'readme.txt')
            ready, partial = serve.Engine._count_models(self.engine, tmp)
            self.assertEqual((ready, partial), (2, 0))

    def test_partial_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._touch(tmp, 'big.safetensors.qkdownloading')
            self._touch(tmp, 'big2.safetensors.part')
            self._touch(tmp, 'done.safetensors')
            ready, partial = serve.Engine._count_models(self.engine, tmp)
            self.assertEqual((ready, partial), (1, 2))

    def test_missing_dir(self):
        ready, partial = serve.Engine._count_models(self.engine, '/definitely/not/here')
        self.assertEqual((ready, partial), (0, 0))


# ============================================================
# 模型扫描
# ============================================================
class TestScanModels(EngineFixture):

    def _touch(self, d, name):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), 'wb') as f:
            f.write(b'x')

    def test_prefers_dir_with_real_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(os.path.join(comfy, 'models', 'checkpoints'), exist_ok=True)
            self._touch(os.path.join(comfy, 'models', 'checkpoints'), 'put_checkpoints_here')

            shared = os.path.join(tmp, 'models')
            self._touch(os.path.join(shared, 'checkpoints'), 'real.safetensors')

            self.engine._state = {'comfy_dir': comfy}
            out = serve.Engine.scan_models(self.engine)

            self.assertTrue(out['found'], '应识别到模型目录')
            self.assertEqual(out['found']['checkpoints'], os.path.join(shared, 'checkpoints'))
            self.assertEqual(out['files']['checkpoints'], 1)

    def test_more_files_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(comfy, exist_ok=True)
            a = os.path.join(comfy, 'models', 'loras')
            b = os.path.join(tmp, 'models', 'loras')
            self._touch(a, 'one.safetensors')
            self._touch(b, 'one.safetensors')
            self._touch(b, 'two.safetensors')

            self.engine._state = {'comfy_dir': comfy}
            out = serve.Engine.scan_models(self.engine)
            self.assertEqual(out['found']['loras'], b)
            self.assertEqual(out['files']['loras'], 2)

    def test_partial_only_dir_is_still_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(comfy, exist_ok=True)
            self._touch(os.path.join(tmp, 'models', 'diffusion_models'), 'x.safetensors.qkdownloading')

            self.engine._state = {'comfy_dir': comfy}
            out = serve.Engine.scan_models(self.engine)
            self.assertIn('diffusion_models', out['found'])
            self.assertEqual(out['files']['diffusion_models'], 0)
            self.assertEqual(out['partial']['diffusion_models'], 1)

    def test_empty_result_when_no_models(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(comfy, exist_ok=True)
            self.engine._state = {'comfy_dir': comfy}
            out = serve.Engine.scan_models(self.engine)
            self.assertEqual(out['found'], {})


# ============================================================
# extra_model_paths.yaml
# ============================================================
class TestWriteYaml(unittest.TestCase):

    def _write(self, comfy_dir, mapping):
        serve.Engine._write_yaml(comfy_dir, mapping)
        target = os.path.join(comfy_dir, 'extra_model_paths.yaml')
        with open(target, encoding='utf-8') as f:
            return f.read()

    def test_top_level_sections_not_nested(self):
        """曾经的 bug：所有 section 套在 loom_shared: 下，ComfyUI 直接抛 AttributeError"""
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(comfy)
            text = self._write(comfy, {
                'loras': os.path.join(tmp, 'models', 'loras'),
                'vae': os.path.join(tmp, 'models', 'vae'),
            })
            self.assertNotIn('loom_shared', text)
            self.assertIn('loom_0:', text)
            self.assertIn('base_path: ' + os.path.join(tmp, 'models'), text)
            # 同一个 base_path 下的两个类型应合并进一个 section
            self.assertIn('    loras: loras', text)
            self.assertIn('    vae: vae', text)
            self.assertEqual(text.count('loom_0:'), 1)

    def test_skips_comfy_builtin_models_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            own = os.path.join(comfy, 'models', 'checkpoints')
            os.makedirs(own)
            text = self._write(comfy, {'checkpoints': own})
            self.assertNotIn(own, text, 'ComfyUI 自带的 models 不该重复挂载')
            self.assertIn('base_path: .', text)   # 空映射时的兜底内容

    def test_multiple_bases_get_separate_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(comfy)
            text = self._write(comfy, {
                'loras': os.path.join(tmp, 'a', 'loras'),
                'vae': os.path.join(tmp, 'b', 'vae'),
            })
            self.assertIn('loom_0:', text)
            self.assertIn('loom_1:', text)

    def test_windows_style_backslashes_normalized(self):
        # 模拟 Windows：写进 yaml 的路径必须是正斜杠，否则 YAML 会把 \\ 当转义
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            os.makedirs(comfy)
            with mock.patch.object(serve.os, 'name', 'nt'):
                text = self._write(comfy, {'loras': 'C:\\models\\loras'})
            self.assertIn('C:/models', text)
            self.assertNotIn('C:\\models', text)


# ============================================================
# 端口 → 进程
# ============================================================
class TestPortPids(EngineFixture):

    def test_lsof_path(self):
        fake = mock.Mock(stdout='123\n456\n', returncode=0)
        with mock.patch.object(serve.subprocess, 'run', return_value=fake) as run:
            pids = serve.Engine._port_pids(8188)
        self.assertEqual(pids, {123, 456})
        self.assertIn('lsof', run.call_args[0][0][0])

    def test_windows_powershell(self):
        with mock.patch.object(serve.Engine, 'IS_WIN', True), \
             mock.patch.object(serve.Engine, '_powershell', return_value='4321\r\n8765'):
            pids = serve.Engine._port_pids(8188)
        self.assertEqual(pids, {4321, 8765})

    def test_windows_netstat_fallback_ignores_established(self):
        netstat = (
            '  TCP    127.0.0.1:8188   0.0.0.0:0    LISTENING    1111\n'
            '  TCP    127.0.0.1:8188   127.0.0.1:52000   ESTABLISHED  2222\n'
            '  TCP    0.0.0.0:80       0.0.0.0:0    LISTENING    3333\n'
        )
        fake = mock.Mock(stdout=netstat)
        with mock.patch.object(serve.Engine, 'IS_WIN', True), \
             mock.patch.object(serve.Engine, '_powershell', return_value=''), \
             mock.patch.object(serve.subprocess, 'run', return_value=fake):
            pids = serve.Engine._port_pids(8188)
        # 只认「监听中」的，且端口必须匹配 —— 别把浏览器的连接算进来
        self.assertEqual(pids, {1111})


class TestLooksLikeComfy(EngineFixture):

    def test_posix_match(self):
        fake = mock.Mock(stdout='/usr/bin/python3 /opt/ComfyUI/main.py --listen\n')
        with mock.patch.object(serve.Engine, 'IS_WIN', False), \
             mock.patch.object(serve.subprocess, 'run', return_value=fake):
            self.assertTrue(serve.Engine._looks_like_comfy(123))

    def test_posix_not_comfy(self):
        fake = mock.Mock(stdout='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n')
        with mock.patch.object(serve.Engine, 'IS_WIN', False), \
             mock.patch.object(serve.subprocess, 'run', return_value=fake):
            self.assertFalse(serve.Engine._looks_like_comfy(123))

    def test_windows_cim(self):
        with mock.patch.object(serve.Engine, 'IS_WIN', True), \
             mock.patch.object(serve.Engine, '_powershell',
                               return_value='"python.exe" main.py --port 8188'):
            self.assertTrue(serve.Engine._looks_like_comfy(123))

    def test_empty_output_is_false(self):
        with mock.patch.object(serve.Engine, 'IS_WIN', False), \
             mock.patch.object(serve.subprocess, 'run', return_value=mock.Mock(stdout='')):
            self.assertFalse(serve.Engine._looks_like_comfy(123))


# ============================================================
# restart 的安全判据
# ============================================================
class TestRestartSafety(EngineFixture):

    def setUp(self):
        super().setUp()
        self.kills = []
        self.engine._state = {'comfy_dir': '/tmp/ComfyUI', 'port': 8188, 'pid': None}

    def _patch(self, owners, comfy_port, looks_like=False, port_open=True):
        return [
            mock.patch.object(serve.Engine, '_port_pids', return_value=set(owners)),
            mock.patch.object(serve.Engine, '_is_comfy_port', return_value=comfy_port),
            mock.patch.object(serve.Engine, '_looks_like_comfy', return_value=looks_like),
            mock.patch.object(serve.Engine, 'port_open', return_value=port_open),
            mock.patch.object(serve.Engine, '_save_state', return_value=None),
            mock.patch.object(serve.os, 'kill', side_effect=self._record_kill),
            mock.patch.object(serve.time, 'sleep', return_value=None),
        ]

    def _record_kill(self, pid, sig):
        self.kills.append((pid, sig))

    def test_refuses_unknown_owner(self):
        patches = self._patch(owners=[9999], comfy_port=False)
        for p in patches:
            p.start()
        try:
            ok, msg = serve.Engine.restart(self.engine)
        finally:
            for p in patches:
                p.stop()
        self.assertFalse(ok)
        self.assertIn('没有动它', msg)
        self.assertEqual(self.kills, [], '认不出来时绝不能动手')

    def test_kills_process_that_answers_as_comfy(self):
        patches = self._patch(owners=[5555], comfy_port=True, port_open=False)
        with mock.patch.object(serve.Engine, 'start', return_value=(True, '已启动')):
            for p in patches:
                p.start()
            try:
                ok, msg = serve.Engine.restart(self.engine)
            finally:
                for p in patches:
                    p.stop()
        self.assertTrue(ok)
        self.assertEqual(self.kills, [(5555, 15)])

    def test_kills_pid_recorded_by_us_even_if_comfy_hangs(self):
        """引擎卡在加载模型时 /system_stats 不回应，但 pid 是我们启动的 → 允许重启"""
        self.engine._state['pid'] = 4242
        patches = self._patch(owners=[4242], comfy_port=False, port_open=False)
        with mock.patch.object(serve.Engine, 'start', return_value=(True, '已启动')):
            for p in patches:
                p.start()
            try:
                ok, _ = serve.Engine.restart(self.engine)
            finally:
                for p in patches:
                    p.stop()
        self.assertTrue(ok)
        self.assertEqual(self.kills, [(4242, 15)])

    def test_stale_recorded_pid_is_not_trusted(self):
        """记录的 pid 早就不占这个端口了 → 不能当成「是我们的引擎」"""
        self.engine._state['pid'] = 4242
        patches = self._patch(owners=[7777], comfy_port=False)
        for p in patches:
            p.start()
        try:
            ok, msg = serve.Engine.restart(self.engine)
        finally:
            for p in patches:
                p.stop()
        self.assertFalse(ok)
        self.assertEqual(self.kills, [])


# ============================================================
# 出图目录
# ============================================================
class TestOutputs(EngineFixture):

    def test_lists_images_newest_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            comfy = os.path.join(tmp, 'ComfyUI')
            out = os.path.join(comfy, 'output')
            os.makedirs(out)
            for name, mtime in (('a.png', 100), ('b.png', 300), ('c.txt', 200), ('d.webp', 200)):
                p = os.path.join(out, name)
                with open(p, 'wb') as f:
                    f.write(b'x')
                os.utime(p, (mtime, mtime))

            self.engine._state = {'comfy_dir': comfy}
            r = serve.Engine.outputs(self.engine)
            self.assertEqual([i['name'] for i in r['items']], ['b.png', 'd.webp', 'a.png'])
            self.assertEqual(r['total'], 3)
            self.assertEqual(r['dir'], out)

    def test_no_engine_dir(self):
        self.engine._state = {'comfy_dir': ''}
        r = serve.Engine.outputs(self.engine)
        self.assertEqual(r['items'], [])


# ============================================================
# 安装器静态契约
# ============================================================
class TestInstallerContract(unittest.TestCase):

    def test_min_python_is_3_10(self):
        self.assertEqual(tuple(serve.Installer.MIN_PY), (3, 10))

    def test_six_steps_in_order(self):
        keys = [k for k, _ in serve.Installer.STEPS]
        self.assertEqual(keys, ['prepare', 'source', 'venv', 'torch', 'deps', 'config'])

    def test_venv_python_per_platform(self):
        path = serve.Installer._venv_python('/tmp/engine')
        if serve.Engine.IS_WIN:
            self.assertTrue(path.endswith(os.path.join('venv', 'Scripts', 'python.exe')))
        else:
            self.assertTrue(path.endswith(os.path.join('venv', 'bin', 'python3')))

    def test_torch_flavor_auto_is_known(self):
        flavor = serve.INSTALLER._torch_flavor('auto')
        # darwin 走官方 pypi（装默认 wheel），其他平台按 nvidia-smi 判 CUDA / CPU
        self.assertIn(flavor, ('pypi', 'cpu', 'cu124', 'cu126'))

    def test_explicit_torch_flavor_passthrough(self):
        self.assertEqual(serve.INSTALLER._torch_flavor('cu126'), 'cu126')
        self.assertEqual(serve.INSTALLER._torch_flavor('cpu'), 'cpu')


if __name__ == '__main__':
    unittest.main(verbosity=2)
