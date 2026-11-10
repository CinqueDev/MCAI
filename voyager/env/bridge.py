import os.path
import logging
import threading
from voyager.tasks import TaskClient
import re
import time
import warnings
from typing import SupportsFloat, Any, Tuple, Dict

import requests
import json

import gymnasium as gym
from gymnasium.core import ObsType

import voyager.utils as U

from .minecraft_launcher import MinecraftInstance
from .process_monitor import SubprocessMonitor


class VoyagerEnv(gym.Env):
    def __init__(
        self,
        mc_port=None,
        azure_login=None,
        server_host="http://127.0.0.1",
        server_port=3000,
        request_timeout=600,
        log_path="./logs",
        mc_host="localhost",
        mc_auth="offline",
        mc_username=None,
        mc_version=None,
        mc_profiles_folder=".minecraft-auth",
        mc_pause_mode="auto",
    ):
        if mc_pause_mode not in ("auto", "none", "mod", "tick"):
            raise ValueError("mc_pause_mode must be auto, none, mod, or tick")
        if not isinstance(mc_host, str) or not mc_host.strip():
            raise ValueError("mc_host must be a non-empty hostname or IP address")
        if mc_auth not in ("offline", "microsoft"):
            raise ValueError("mc_auth must be 'offline' or 'microsoft'")
        if mc_username is not None and (not isinstance(mc_username, str) or not mc_username.strip()):
            raise ValueError("mc_username must be a non-empty string")
        if mc_auth == "microsoft" and not mc_username:
            raise ValueError("mc_username is required for Microsoft login (account email or cache identifier)")
        mc_username = mc_username or "bot"
        if mc_auth == "offline" and not re.fullmatch(r"[A-Za-z0-9_]{1,16}", mc_username):
            raise ValueError("Offline mc_username must contain 1-16 letters, digits, or underscores")
        if mc_port is not None and (isinstance(mc_port, bool) or not isinstance(mc_port, int) or not 1 <= mc_port <= 65535):
            raise ValueError("mc_port must be an integer between 1 and 65535")
        if azure_login and (mc_host != "localhost" or mc_auth != "offline"):
            raise ValueError("azure_login launches a local world; omit it for direct multiplayer connections")
        if mc_port is None and not azure_login and mc_host != "localhost":
            mc_port = 25565
        if not mc_port and not azure_login:
            raise ValueError("Either mc_port or azure_login must be specified")
        if mc_port and azure_login:
            warnings.warn(
                "Both mc_port and mc_login are specified, mc_port will be ignored"
            )
        self.mc_host = mc_host
        self.mc_auth = mc_auth
        self.mc_username = mc_username
        self.mc_version = mc_version
        self.mc_profiles_folder = os.path.abspath(os.path.expanduser(mc_profiles_folder))
        self.mc_pause_mode = mc_pause_mode
        if mc_pause_mode == "auto":
            self.mc_pause_mode = "mod" if (
                mc_host in ("localhost", "127.0.0.1", "::1") and mc_auth == "offline"
            ) else "none"
        self.mc_pause = self.mc_pause_mode != "none"
        self.mc_port = mc_port
        self.azure_login = azure_login
        self.server = f"{server_host}:{server_port}"
        self.server_port = server_port
        self.request_timeout = request_timeout
        self.log_path = log_path
        self.mineflayer = self.get_mineflayer_process(server_port)
        if azure_login:
            self.mc_instance = self.get_mc_instance()
        else:
            self.mc_instance = None
        self.has_reset = False
        self.reset_options = None
        self.conversation = None
        self.current_task = None
        self.task_recipient = None
        self.player_request = False
        self.execution = None
        self.tasks = TaskClient(self)
        self.world_memory = None
        self.task_requester = None
        self.task_journal_path = None
        self.task_operators = []
        self.connected = False
        self.server_paused = False
        self.reconnect_lock = threading.Lock()

    def get_mineflayer_process(self, server_port):
        U.f_mkdir(self.log_path, "mineflayer")
        file_path = os.path.abspath(os.path.dirname(__file__))
        return SubprocessMonitor(
            commands=[
                "node",
                U.f_join(file_path, "mineflayer/index.js"),
                str(server_port),
            ],
            name="mineflayer",
            output_match=r"^Microsoft sign-in:",
            ready_match=r"Server started on port (\d+)",
            log_path=U.f_join(self.log_path, "mineflayer"),
        )

    def get_mc_instance(self):
        print("Creating Minecraft server")
        U.f_mkdir(self.log_path, "minecraft")
        return MinecraftInstance(
            **self.azure_login,
            mineflayer=self.mineflayer,
            log_path=U.f_join(self.log_path, "minecraft"),
        )

    def check_process(self):
        if self.mc_instance and not self.mc_instance.is_running:
            # if self.mc_instance:
            #     self.mc_instance.check_process()
            #     if not self.mc_instance.is_running:
            print("Starting Minecraft server")
            self.mc_instance.run()
            self.mc_port = self.mc_instance.port
            self.reset_options["port"] = self.mc_instance.port
            print(f"Server started on port {self.reset_options['port']}")
        retry = 0
        while not self.mineflayer.is_running:
            print("Mineflayer process has exited, restarting")
            self.mineflayer.run()
            if not self.mineflayer.is_running:
                retry += 1
                if retry > 3:
                    raise RuntimeError("Mineflayer process failed to start")
                else:
                    continue
            print(self.mineflayer.ready_line)
            res = requests.post(
                f"{self.server}/start",
                json=self.reset_options,
                timeout=self.request_timeout,
            )
            if res.status_code != 200:
                self.mineflayer.stop()
                raise RuntimeError(
                    f"Minecraft connection failed ({res.status_code}): {res.text}"
                )
            return res.json()

    def reconnect(self):
        """Rejoin an existing world without clearing inventory or restoring old coordinates."""
        if not self.has_reset or not self.reset_options:
            raise RuntimeError("Cannot reconnect before the first Minecraft connection")
        with self.reconnect_lock:
            if not self.mineflayer.is_running:
                self.mineflayer.run()
                if not self.mineflayer.is_running:
                    raise RuntimeError("Could not restart the Minecraft bridge")
            probe = requests.post(f"{self.server}/tasks", json={"operation": "snapshot"}, timeout=10)
            if probe.status_code == 200:
                return
            self.connected = False
            options = {**self.reset_options, "reset": "soft", "inventory": {}, "equipment": [],
                       "position": None, "spread": False, "waitTicks": 0, "serverPaused": self.server_paused}
            response = requests.post(f"{self.server}/start", json=options, timeout=self.request_timeout)
            if response.status_code != 200:
                self.connected = False
                raise RuntimeError(f"Minecraft reconnection failed: {response.text}")
            self.connected = True
            self.server_paused = False
            self.remember_observations(json.loads(response.json()))
            # Restore normal per-action observation timing after the tick-free handshake.
            requests.post(f"{self.server}/observe", json={"waitTicks": self.reset_options.get("waitTicks", 5)}, timeout=10).raise_for_status()

    def step(
        self,
        code: str,
        programs: str = "",
    ) -> Tuple[ObsType, SupportsFloat, bool, bool, Dict[str, Any]]:
        if not self.has_reset:
            raise RuntimeError("Environment has not been reset yet")
        self.check_process()
        self.unpause()
        data = {
            "code": code,
            "programs": programs,
            "playerRequest": self.player_request,
            "execution": self.execution,
            "task": {"description": self.current_task, "recipient": self.task_recipient},
        }
        if self.world_memory:
            data["worldMemory"] = self.world_memory.context(self.current_task or "", actor=self.task_recipient,
                kinds=["place", "resource", "storage", "project"], limit=50)
        res = requests.post(
            f"{self.server}/step", json=data, timeout=self.request_timeout
        )
        if res.status_code != 200:
            raise RuntimeError("Failed to step Minecraft server")
        returned_data = res.json()
        self.pause()
        events = json.loads(returned_data)
        self.remember_observations(events)
        return events

    def remember_observations(self, events):
        if self.world_memory:
            try:
                for _, event in events:
                    self.world_memory.ingest(event.get("status", {}))
            except Exception:
                logging.getLogger(__name__).exception("Could not store world observations; continuing Minecraft execution")

    def render(self):
        raise NotImplementedError("render is not implemented")

    def reset(
        self,
        *,
        seed=None,
        options=None,
    ) -> Tuple[ObsType, Dict[str, Any]]:
        if options is None:
            options = {}

        if options.get("inventory", {}) and options.get("mode", "hard") != "hard":
            raise RuntimeError("inventory can only be set when options is hard")

        # Task boundaries need fresh observations, not a reconnect that loses chat.
        if (options.get("mode") == "soft" and self.has_reset and self.connected
                and self.mineflayer.is_running
                and not any(options.get(key) for key in ("inventory", "equipment", "position", "spread"))):
            response = requests.post(
                f"{self.server}/observe", json={"waitTicks": options.get("wait_ticks", 5)},
                timeout=self.request_timeout,
            )
            if response.status_code != 200:
                raise RuntimeError(f"Failed to observe Minecraft server: {response.text}")
            events = json.loads(response.json())
            self.remember_observations(events)
            return events

        self.reset_options = {
            "host": self.mc_host,
            "port": self.mc_port,
            "auth": self.mc_auth,
            "username": self.mc_username,
            "version": self.mc_version,
            "profilesFolder": self.mc_profiles_folder,
            "pauseMode": self.mc_pause_mode,
            "taskJournalPath": self.task_journal_path,
            "taskOperators": self.task_operators,
            "reset": options.get("mode", "hard"),
            "inventory": options.get("inventory", {}),
            "equipment": options.get("equipment", []),
            "spread": options.get("spread", False),
            "waitTicks": options.get("wait_ticks", 5),
            "position": options.get("position", None),
        }

        self.connected = False
        self.unpause()
        self.mineflayer.stop()
        time.sleep(1)  # wait for mineflayer to exit

        returned_data = self.check_process()
        self.has_reset = True
        self.connected = True
        if self.conversation:
            self.conversation.start()
        # All the reset in step will be soft
        self.reset_options["reset"] = "soft"
        self.pause()
        events = json.loads(returned_data)
        self.remember_observations(events)
        return events

    def close(self):
        if self.conversation:
            self.conversation.stop()
        if self.connected:
            self.unpause()
        if self.connected:
            res = requests.post(f"{self.server}/stop")
            if res.status_code == 200:
                self.connected = False
        if self.mc_instance:
            self.mc_instance.stop()
        self.mineflayer.stop()
        return not self.connected

    def _set_paused(self, paused):
        if self.mc_pause and self.mineflayer.is_running and self.server_paused != paused:
            res = requests.post(
                f"{self.server}/pause",
                json={"paused": paused, "mode": self.mc_pause_mode},
                timeout=self.request_timeout,
            )
            if res.status_code != 200:
                raise RuntimeError(f"Failed to change Minecraft pause state: {res.text}")
            payload = res.json()
            self.server_paused = payload.get("paused", paused) if isinstance(payload, dict) else paused
        return self.server_paused

    def pause(self):
        return self._set_paused(True)

    def unpause(self):
        return self._set_paused(False)
