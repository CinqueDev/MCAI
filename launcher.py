"""Standard-library bootstrap for a launch without shell activation."""

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
SUPPORTED_PYTHONS = {(3, 10), (3, 11)}


def python_version(executable):
    try:
        result = subprocess.run(
            [str(executable), "-c", "import sys; print('%s.%s' % sys.version_info[:2])"],
            check=True, capture_output=True, text=True,
        )
        return tuple(map(int, result.stdout.strip().split(".")))
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def fingerprint(paths):
    digest = hashlib.sha256(str(ROOT).encode())
    for path in paths:
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def install_if_changed(stamp, digest, command, cwd):
    if stamp.is_file() and stamp.read_text().strip() == digest:
        return
    print("Preparing project dependencies (first launch or setup changed)...", flush=True)
    subprocess.run(command, cwd=cwd, check=True)
    # Write only after a successful install; failed installs are retried next time.
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(digest + "\n")


def ensure_runtime():
    """Select .venv, set it up when needed, then continue in the same process."""
    try:
        _ensure_runtime()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Launcher setup failed: {error}") from None


def _ensure_runtime():
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise RuntimeError("Install Node.js 22+ (including npm), then run python3 run.py again.")
    version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if int(version.lstrip("v").split(".")[0]) < 22:
        raise RuntimeError("Node.js 22+ is required; update Node.js, then run python3 run.py again.")

    venv = ROOT / ".venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        if venv.exists():
            raise RuntimeError(".venv exists but its Python executable is missing. Rename it and retry to create a fresh environment.")
        candidates = [sys.executable, shutil.which("python3.11"), shutil.which("python3.10")]
        creator = next((candidate for candidate in candidates if candidate and
                        python_version(candidate) in SUPPORTED_PYTHONS), None)
        if not creator:
            raise RuntimeError("Install Python 3.11 or 3.10, then run python3 run.py again.")
        print("Creating the project's Python virtual environment...", flush=True)
        subprocess.run([str(creator), "-m", "venv", str(venv)], check=True)
    if python_version(python) not in SUPPORTED_PYTHONS:
        raise RuntimeError("The project .venv must use Python 3.10 or 3.11. Rename it and retry after installing Python 3.11.")

    if Path(sys.prefix).resolve() != venv.resolve():
        # No shell activation, aliases, or global pip installs are needed.
        os.execv(str(python), [str(python), str(ROOT / "run.py"), *sys.argv[1:]])
        return

    install_if_changed(
        venv / ".launcher-python", fingerprint([ROOT / "requirements.txt", ROOT / "setup.py"]),
        [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-e", str(ROOT)], ROOT,
    )
    bridge = ROOT / "voyager/env/mineflayer"
    sources = [bridge / "package.json", bridge / "package-lock.json",
               bridge / "mineflayer-collectblock/package.json", bridge / "mineflayer-collectblock/tsconfig.json"]
    sources += sorted((bridge / "mineflayer-collectblock/src").glob("*.ts"))
    digest = fingerprint(sources)
    if not (bridge / "mineflayer-collectblock/lib/index.js").is_file():
        # An existing node_modules directory alone does not guarantee the custom
        # collection plugin was built successfully.
        digest += "-missing-build"
    install_if_changed(
        bridge / "node_modules/.launcher-node", digest,
        [npm, "ci", "--no-audit", "--no-fund"], bridge,
    )
    # Record the normal fingerprint once npm's postinstall has built the plugin.
    if digest.endswith("-missing-build") and (bridge / "mineflayer-collectblock/lib/index.js").is_file():
        (bridge / "node_modules/.launcher-node").write_text(fingerprint(sources) + "\n")
