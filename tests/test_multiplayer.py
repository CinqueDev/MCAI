import json
import os
import unittest
from unittest.mock import Mock, patch

from voyager import Voyager
from voyager.env import VoyagerEnv


class MultiplayerTests(unittest.TestCase):
    def make_env(self, **kwargs):
        with patch.object(VoyagerEnv, "get_mineflayer_process"):
            return VoyagerEnv(**kwargs)

    def test_lan_defaults_preserved(self):
        env = self.make_env(mc_port=12345)
        self.assertEqual((env.mc_host, env.mc_auth, env.mc_username),
                         ("localhost", "offline", "bot"))
        self.assertTrue(env.mc_pause)

    def test_remote_default_port_and_pause(self):
        env = self.make_env(mc_host="example.org")
        self.assertEqual(env.mc_port, 25565)
        self.assertFalse(env.mc_pause)
        with patch("voyager.env.bridge.requests.post") as post:
            self.assertFalse(env.pause())
            self.assertFalse(env.unpause())
            post.assert_not_called()

    def test_world_protection_overrides_every_pause_mode(self):
        for mode in ("auto", "none", "mod", "tick"):
            with self.subTest(mode=mode):
                env = self.make_env(mc_port=25565, mc_pause_mode=mode, mc_allow_world_changes=False)
                self.assertFalse(env.mc_allow_world_changes)
                self.assertEqual(env.mc_pause_mode, "none")
                with patch("voyager.env.bridge.requests.post") as post:
                    self.assertFalse(env.pause())
                    self.assertFalse(env.unpause())
                    post.assert_not_called()

    def test_microsoft_local_connection_does_not_pause_by_default(self):
        env = self.make_env(mc_port=25565, mc_auth="microsoft", mc_username="account")
        self.assertFalse(env.mc_pause)
        self.assertTrue(self.make_env(mc_host="remote", mc_pause_mode="mod").mc_pause)
        self.assertFalse(self.make_env(mc_port=12345, mc_pause_mode="none").mc_pause)

    def test_invalid_settings_fail_before_subprocess_creation(self):
        for kwargs in [dict(mc_port=0), dict(mc_port=65536), dict(mc_port=True),
                       dict(mc_port=25565, mc_allow_world_changes="false"),
                       dict(mc_port=25565, mc_auth="invalid"),
                       dict(mc_port=25565, mc_auth="microsoft"),
                       dict(mc_port=25565, mc_username="bad name"),
                       dict(mc_host="remote", azure_login={"client_id": "id"})]:
            with self.subTest(kwargs=kwargs), patch.object(VoyagerEnv, "get_mineflayer_process") as process:
                with self.assertRaises(ValueError):
                    VoyagerEnv(**kwargs)
                process.assert_not_called()

    def test_reset_forwards_options_and_reconnect_preserves_them(self):
        env = self.make_env(mc_host="example.org", mc_auth="microsoft", mc_username="account",
                            mc_version="1.19", mc_profiles_folder=".minecraft-auth", mc_allow_world_changes=False)
        with patch("voyager.env.bridge.time.sleep"), patch.object(env, "check_process", return_value=json.dumps([])):
            env.reset()
        self.assertEqual(env.reset_options["host"], "example.org")
        self.assertEqual(env.reset_options["auth"], "microsoft")
        self.assertEqual(env.reset_options["username"], "account")
        self.assertEqual(env.reset_options["version"], "1.19")
        self.assertEqual(env.reset_options["profilesFolder"], os.path.abspath(".minecraft-auth"))
        self.assertEqual(env.reset_options["reset"], "soft")
        self.assertFalse(env.reset_options["allowWorldChanges"])
        self.assertEqual(env.reset_options["pauseMode"], "none")
        env.mineflayer.is_running = False
        env.mineflayer.run.side_effect = lambda: setattr(env.mineflayer, "is_running", True)
        with patch("voyager.env.bridge.requests.post", return_value=Mock(status_code=200)) as post:
            env.check_process()
        self.assertEqual(post.call_args.kwargs["json"], env.reset_options)

    def test_connection_failure_includes_server_reason(self):
        env = self.make_env(mc_host="example.org")
        env.mineflayer.is_running = False
        env.mineflayer.run.side_effect = lambda: setattr(env.mineflayer, "is_running", True)
        with patch("voyager.env.bridge.requests.post", return_value=Mock(status_code=400, text="Not whitelisted")):
            with self.assertRaisesRegex(RuntimeError, "Not whitelisted"):
                env.check_process()

    def test_tick_pause_uses_explicit_state_and_close_unfreezes_before_stop(self):
        env = self.make_env(mc_host="example.org", mc_pause_mode="tick")
        env.connected = True
        with patch("voyager.env.bridge.requests.post", return_value=Mock(status_code=200)) as post:
            self.assertTrue(env.pause())
            env.pause()  # Idempotent.
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.kwargs["json"], {"paused": True, "mode": "tick"})
            env.close()
            self.assertEqual(post.call_args_list[1].kwargs["json"], {"paused": False, "mode": "tick"})
            self.assertTrue(post.call_args_list[2].args[0].endswith("/stop"))
        self.assertFalse(env.server_paused)

    def test_failed_tick_pause_does_not_claim_paused(self):
        env = self.make_env(mc_host="example.org", mc_pause_mode="tick")
        with patch("voyager.env.bridge.requests.post", return_value=Mock(status_code=400, text="No permission")):
            with self.assertRaisesRegex(RuntimeError, "No permission"):
                env.pause()
        self.assertFalse(env.server_paused)

    def test_voyager_forwards_connection_options(self):
        with patch("voyager.voyager.VoyagerEnv") as env, patch("voyager.voyager.ActionAgent", side_effect=RuntimeError("stop after env")):
            with self.assertRaisesRegex(RuntimeError, "stop after env"):
                Voyager(mc_host="example.org", mc_auth="microsoft", mc_username="account",
                        mc_version="1.19", mc_profiles_folder="cache", mc_pause_mode="none",
                        deepseek_api_key="test", mc_allow_world_changes=False)
        options = env.call_args.kwargs
        self.assertEqual(options["mc_host"], "example.org")
        self.assertEqual(options["mc_auth"], "microsoft")
        self.assertEqual(options["mc_username"], "account")
        self.assertEqual(options["mc_profiles_folder"], "cache")
        self.assertEqual(options["mc_pause_mode"], "none")
        self.assertFalse(options["mc_allow_world_changes"])
