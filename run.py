"""Run Voyager against a Minecraft world opened to LAN."""

import argparse

from voyager import Voyager


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mc-port", type=int, required=True)
    parser.add_argument("--ckpt-dir", default="ckpt")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    voyager = Voyager(
        mc_port=args.mc_port, ckpt_dir=args.ckpt_dir, resume=args.resume
    )
    try:
        voyager.learn()
    finally:
        voyager.close()


if __name__ == "__main__":
    main()
