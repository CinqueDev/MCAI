import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import launcher


class LauncherTests(unittest.TestCase):
    def prepare(self, directory):
        root = Path(directory)
        python = root / '.venv/bin/python'
        python.parent.mkdir(parents=True)
        python.touch()
        for name in ['requirements.txt', 'setup.py',
                     'voyager/env/mineflayer/package.json',
                     'voyager/env/mineflayer/package-lock.json',
                     'voyager/env/mineflayer/mineflayer-collectblock/package.json',
                     'voyager/env/mineflayer/mineflayer-collectblock/tsconfig.json',
                     'voyager/env/mineflayer/mineflayer-collectblock/src/index.ts']:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
        return root, python

    def test_selects_project_python_and_forwards_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root, python = self.prepare(directory)
            with patch.object(launcher, 'ROOT', root), patch.object(launcher.shutil, 'which', side_effect=lambda name: '/tools/' + name), patch.object(launcher, 'python_version', return_value=(3, 11)), patch.object(launcher.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='v22.22.2')), patch.object(launcher.os, 'execv') as execute, patch.object(launcher.sys, 'argv', ['run.py', '--config', 'custom.json']):
                launcher.ensure_runtime()
                execute.assert_called_once_with(str(python), [str(python), str(root/'run.py'), '--config', 'custom.json'])

    def test_installs_once_and_refreshes_changed_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root, python = self.prepare(directory)
            calls = []
            def execute(command, **kwargs):
                calls.append(command)
                if 'ci' in command:
                    build = root/'voyager/env/mineflayer/mineflayer-collectblock/lib/index.js'
                    build.parent.mkdir(parents=True, exist_ok=True)
                    build.touch()
                return subprocess.CompletedProcess(command, 0, stdout='v22.22.2')
            with patch.object(launcher, 'ROOT', root), patch.object(launcher.shutil, 'which', side_effect=lambda name: '/tools/' + name), patch.object(launcher, 'python_version', return_value=(3, 11)), patch.object(launcher.sys, 'prefix', str(root/'.venv')), patch.object(launcher.subprocess, 'run', side_effect=execute), contextlib.redirect_stdout(io.StringIO()):
                launcher.ensure_runtime()
                self.assertEqual(len(calls), 3)  # Node version, pip, npm.
                calls.clear()
                launcher.ensure_runtime()
                self.assertEqual(len(calls), 1)  # No repeated pip/npm.
                (root/'requirements.txt').write_text('changed')
                calls.clear()
                launcher.ensure_runtime()
                self.assertEqual(len(calls), 2)
                self.assertIn('pip', calls[-1])
                # Missing compiled plugin triggers a rebuild even with a stamp.
                (root/'voyager/env/mineflayer/mineflayer-collectblock/lib/index.js').unlink()
                calls.clear()
                launcher.ensure_runtime()
                self.assertIn('ci', calls[-1])

    def test_failed_install_is_not_marked_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            stamp = Path(directory)/'stamp'
            with patch.object(launcher.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['pip'])), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(subprocess.CalledProcessError):
                launcher.install_if_changed(stamp, 'fingerprint', ['pip'], directory)
            self.assertFalse(stamp.exists())

    def test_missing_node_has_actionable_error(self):
        with patch.object(launcher.shutil, 'which', return_value=None), self.assertRaisesRegex(SystemExit, 'Node.js 22'):
            launcher.ensure_runtime()


if __name__ == '__main__':
    unittest.main()
