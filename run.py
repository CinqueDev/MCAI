"""Run Voyager against a Minecraft Java LAN world or multiplayer server."""

import argparse

from voyager import Voyager


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mc-host", default="localhost")
    parser.add_argument("--mc-port", type=int, required=True)
    parser.add_argument("--mc-auth", choices=("offline", "microsoft"), default="offline")
    parser.add_argument("--mc-username", help="Offline player name or Microsoft account/cache identifier")
    parser.add_argument("--mc-version", help="Minecraft version; omitted for automatic detection")
    parser.add_argument("--mc-profiles-folder", default=".minecraft-auth")
    parser.add_argument("--mc-pause-mode", choices=("auto", "none", "mod", "tick"), default="auto",
                        help="auto: pause mod for local offline worlds, otherwise none; tick: Java 1.20.3+ with OP")
    parser.add_argument("--ckpt-dir", default="ckpt")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    voyager = Voyager(
        mc_port=args.mc_port, mc_host=args.mc_host, mc_auth=args.mc_auth,
        mc_username=args.mc_username, mc_version=args.mc_version,
        mc_profiles_folder=args.mc_profiles_folder, mc_pause_mode=args.mc_pause_mode,
        ckpt_dir=args.ckpt_dir, resume=args.resume
    )
    try:
        voyager.learn()
    finally:
        voyager.close()


if __name__ == "__main__":
    main()
