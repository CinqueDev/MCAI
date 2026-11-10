import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run


class LaunchConfigTests(unittest.TestCase):
    def write_config(self, directory, **settings):
        path = Path(directory) / "config.json"
        path.write_text(json.dumps({"mc_port": 25565, **settings}))
        return path

    def test_config_settings_and_cli_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_config(directory, mc_version="26.1", mc_pause_mode="none",
                                     resume=True, ckpt_dir="saved")
            settings, env_path = run.parse_settings([
                "--config", str(path), "--mc-port", "49532", "--no-resume", "--no-chat-enabled"])
            self.assertEqual(settings["mc_port"], 49532)
            self.assertEqual(settings["mc_version"], "26.1")
            self.assertFalse(settings["resume"])
            self.assertFalse(settings["chat_enabled"])
            self.assertEqual(settings["ckpt_dir"], str(Path(directory).resolve() / "saved"))
            self.assertEqual(env_path, Path(directory).resolve() / ".env")

    def test_default_config_is_independent_of_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_config(directory)
            with patch.object(run, "DEFAULT_CONFIG", path):
                settings, env_path = run.parse_settings([])
            self.assertEqual(settings["mc_port"], 25565)
            self.assertEqual(env_path, Path(directory).resolve() / ".env")

    def test_legacy_cli_works_without_config(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
                run, "DEFAULT_CONFIG", Path(directory) / "missing.json"):
            settings, _ = run.parse_settings(["--mc-port", "12345", "--resume", "--ckpt-dir", "relative"])
        self.assertEqual(settings["mc_port"], 12345)
        self.assertTrue(settings["resume"])
        self.assertEqual(settings["ckpt_dir"], "relative")

    def test_invalid_settings_fail_before_launch(self):
        for values in [{"mc_port": True}, {"mc_port": 70000}, {"resume": "false"},
                       {"chat_enabled": "false"}, {"mc_version": 26.1}, {"mc_auth": "bad"},
                       {"mc_auth": "microsoft"}, {"mc_pause_mode": "bad"},
                       {"deepseek_api_key": "do-not-print-this"}]:
            with self.subTest(values=values), tempfile.TemporaryDirectory() as directory:
                path = self.write_config(directory, **values)
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                    run.parse_settings(["--config", str(path)])
                self.assertNotIn("do-not-print-this", stderr.getvalue())

    def test_missing_or_malformed_config_fails_clearly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            for content in (None, "not JSON", "[]"):
                if content is not None:
                    path.write_text(content)
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    run.parse_settings(["--config", str(path)])

    def test_dotenv_loads_before_voyager_and_preserves_shell_variables(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_config(directory)
            (Path(directory) / ".env").write_text("DEEPSEEK_API_KEY=file-key\n")
            for existing, expected in [({}, "file-key"), ({"DEEPSEEK_API_KEY": "shell-key"}, "shell-key")]:
                with self.subTest(existing=bool(existing)), patch.dict(os.environ, existing, clear=True), patch.object(run, "Voyager") as voyager:
                    voyager.side_effect = lambda **kwargs: self.assertEqual(
                        os.environ["DEEPSEEK_API_KEY"], expected) or voyager.return_value
                    run.main(["--config", str(path)])
                    voyager.return_value.learn.assert_called_once()
                    voyager.return_value.close.assert_called_once()

    def test_close_runs_if_learning_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_config(directory)
            with patch.object(run, "Voyager") as voyager:
                voyager.return_value.learn.side_effect = RuntimeError("failure")
                with self.assertRaisesRegex(RuntimeError, "failure"):
                    run.main(["--config", str(path)])
                voyager.return_value.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
