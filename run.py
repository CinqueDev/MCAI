"""Run Voyager using config.json, .env, and optional command-line overrides."""

import argparse
import json
from pathlib import Path

from dotenv import load_dotenv

from voyager import Voyager


DEFAULT_CONFIG = Path(__file__).resolve().parent / "config.json"
DEFAULTS = {
    "mc_host": "localhost",
    "mc_port": None,
    "mc_auth": "offline",
    "mc_username": None,
    "mc_version": None,
    "mc_profiles_folder": ".minecraft-auth",
    "mc_pause_mode": "auto",
    "ckpt_dir": "ckpt",
    "resume": False,
    "chat_enabled": True,
}


def parse_settings(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="JSON settings file (default: config.json beside run.py)")
    parser.add_argument("--mc-host", default=argparse.SUPPRESS)
    parser.add_argument("--mc-port", type=int, default=argparse.SUPPRESS)
    parser.add_argument("--mc-auth", choices=("offline", "microsoft"), default=argparse.SUPPRESS)
    parser.add_argument("--mc-username", default=argparse.SUPPRESS,
                        help="Offline player name or Microsoft account/cache identifier")
    parser.add_argument("--mc-version", default=argparse.SUPPRESS,
                        help="Minecraft version; omitted for automatic detection")
    parser.add_argument("--mc-profiles-folder", default=argparse.SUPPRESS)
    parser.add_argument("--mc-pause-mode", choices=("auto", "none", "mod", "tick"),
                        default=argparse.SUPPRESS)
    parser.add_argument("--ckpt-dir", default=argparse.SUPPRESS)
    parser.add_argument("--chat-enabled", action=argparse.BooleanOptionalAction, default=argparse.SUPPRESS)
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=argparse.SUPPRESS)
    overrides = vars(parser.parse_args(argv))
    supplied_config = overrides.pop("config")
    config_path = (supplied_config or DEFAULT_CONFIG).expanduser().resolve()
    config = {}
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            parser.error(f"Cannot read {config_path}: expected a valid JSON settings file")
        if not isinstance(config, dict):
            parser.error("Config must be a JSON object")
        if set(config) - set(DEFAULTS):
            parser.error("Unknown config setting(s): " + ", ".join(sorted(set(config) - set(DEFAULTS))))
    elif supplied_config is not None:
        parser.error(f"Config file does not exist: {config_path}")

    settings = {**DEFAULTS, **config, **overrides}
    if type(settings["mc_port"]) is not int or not 1 <= settings["mc_port"] <= 65535:
        parser.error("Set mc_port to an integer from 1 to 65535 in config.json or use --mc-port")
    if type(settings["chat_enabled"]) is not bool:
        parser.error("chat_enabled must be a JSON boolean (true or false)")
    if type(settings["resume"]) is not bool:
        parser.error("resume must be a JSON boolean (true or false)")
    for key in ("mc_host", "mc_profiles_folder", "ckpt_dir", "mc_auth", "mc_pause_mode"):
        if not isinstance(settings[key], str) or not settings[key].strip():
            parser.error(f"{key} must be a non-empty string")
    for key in ("mc_username", "mc_version"):
        if settings[key] is not None and (not isinstance(settings[key], str) or not settings[key].strip()):
            parser.error(f"{key} must be a non-empty string or null")
    if settings["mc_auth"] not in ("offline", "microsoft"):
        parser.error("mc_auth must be offline or microsoft")
    if settings["mc_pause_mode"] not in ("auto", "none", "mod", "tick"):
        parser.error("mc_pause_mode must be auto, none, mod, or tick")
    if settings["mc_auth"] == "microsoft" and not settings["mc_username"]:
        parser.error("mc_username is required for Microsoft authentication")

    # Paths written in JSON belong to that configuration, even from another cwd.
    # Paths explicitly passed on the CLI retain normal cwd-relative semantics.
    for key in ("ckpt_dir", "mc_profiles_folder"):
        if key in config and key not in overrides:
            path = Path(settings[key]).expanduser()
            settings[key] = str(path if path.is_absolute() else config_path.parent / path)
    return settings, config_path.parent / ".env"


def main(argv=None):
    settings, env_path = parse_settings(argv)
    # Existing shell variables take priority. Never read a parent directory's .env.
    load_dotenv(dotenv_path=env_path, override=False)
    voyager = Voyager(**settings)
    try:
        voyager.learn()
    finally:
        voyager.close()


if __name__ == "__main__":
    main()
