# Voyager with DeepSeek

This fork of [MineDojo/Voyager](https://github.com/MineDojo/Voyager) uses
DeepSeek for Minecraft action generation, curriculum planning, question answering,
task verification, and skill descriptions. All five chat clients default to
`deepseek-flash`, the current Flash API alias documented by
[DeepSeek](https://api-docs.deepseek.com/).

Skill and question retrieval use the local
`sentence-transformers/all-MiniLM-L6-v2` embedding model. No OpenAI account or
embedding API key is needed. The `openai` Python package is used only as the
OpenAI-compatible HTTP client for DeepSeek.

## Installation

Use Python **3.10 or 3.11** for Voyager's legacy Chroma/LangChain dependencies,
and **Node.js 22 or newer** for the updated Minecraft client. From the repository root:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cd voyager/env/mineflayer
npm ci
cd ../../..
```

For a manual launcher session, open a Minecraft **Java Edition** world to LAN
with cheats enabled and note its port. Newer vanilla releases can run without
Fabric using `--mc-pause-mode none`, or the built-in tick command described below.
The [Minecraft instance](installation/minecraft_instance_install.md) and
[Fabric mods](installation/fabric_mods_install.md) guides describe the original
1.19 setup; do not install those old mod builds into newer Minecraft versions.

## Minecraft versions

The client stack now uses Mineflayer 4.39 and current block, item and recipe
libraries. Upstream Mineflayer lists Java 1.20.x, 1.21.x and 26.1 among its
[tested versions](https://github.com/PrismarineJS/mineflayer/blob/master/lib/version.js).
This is client protocol support, not a claim that Voyager's complete learning
loop has been tested in-game on every release. Bedrock is not supported.

For example, to use a local vanilla Java 1.21.11 LAN world:

```bash
python run.py --mc-port 12345 --mc-version 1.21.11 --mc-pause-mode none
```

Replace the port with the world's LAN port. Omit `--mc-version` for automatic
server version detection. `--mc-pause-mode tick` is also available on Java
1.20.3+ with the permissions and feedback settings documented below.

Installation builds the bundled custom block-collection plugin automatically.
To rebuild it after editing TypeScript, run `npm run build:collectblock` inside
`voyager/env/mineflayer`. The lockfile fixes the installed dependency versions.

Run local compatibility checks from the same directory:

```bash
npm run check:compatibility
# Or check a specific release:
npm run check:compatibility -- 1.21.11
```

These checks load the plugins and verify block/item data, crafting recipes,
pathfinder initialization and setup commands for 1.19, 1.19.4, 1.20.1, 1.20.6,
1.21.1, 1.21.4, 1.21.8, 1.21.11 and 26.1 without connecting to Minecraft.
Joining, Microsoft login, movement, mining, crafting, combat and save/resume
still need in-game validation on the chosen server. The bundled learned skills
were created on 1.19 and may need revision for changed mechanics or recipes.
Voyager switches its setup gamerules to the renamed identifiers on 1.21.11+.

## Run with DeepSeek

Create a key in the [DeepSeek API platform](https://platform.deepseek.com/), then
save it in `.env` beside `config.json`:

```dotenv
DEEPSEEK_API_KEY=your-deepseek-api-key
```

For a fresh checkout, copy `config.example.json` to `config.json` and
`.env.example` to `.env`, then edit the copies. Both personal files are ignored
by Git; keep the API key in `.env`, not in JSON. Existing exported environment
variables take priority over `.env` values.

For example, a local Java 26.1 LAN configuration is:

```json
{
  "mc_host": "localhost",
  "mc_port": 49532,
  "mc_auth": "offline",
  "mc_username": "bot",
  "mc_version": "26.1",
  "mc_pause_mode": "none",
  "ckpt_dir": "ckpt-first-run",
  "resume": false
}
```

Replace `49532` with the LAN port shown by Minecraft. Use `resume: false` for
a new checkpoint, then `resume: true` to continue an initialized checkpoint.
Keep Minecraft version numbers quoted; use `null` for automatic detection.
You can then launch without arguments:

```bash
python run.py
```

Command-line options override JSON settings, which override built-in defaults:

```bash
python run.py --mc-port 54321
python run.py --resume
python run.py --ckpt-dir ckpt-new-world --no-resume
python run.py --config /path/to/another/config.json
```

By default, `config.json` is found beside `run.py`, regardless of the working
directory. With `--config`, `.env` is read beside the selected JSON file.
Relative checkpoint and authentication-cache paths in JSON are resolved against
the JSON file's directory; explicit CLI paths are relative to the working
directory. Running with CLI settings and no config file remains supported.
JSON keys use the Python-style names shown in `config.example.json`; unknown
keys and invalid types produce a startup error.

The first run downloads the
embedding model from Hugging Face; later searches run locally on the CPU.
DeepSeek chat requests still require internet access and a funded API account.
`.env` loading happens in `run.py`; when using the Python API directly, pass
the key explicitly, export it, or load `.env` in your own script.

You can also use the Python interface:

```python
from voyager import Voyager

voyager = Voyager(mc_port=12345)
voyager.learn()
```

Pass `deepseek_api_key="..."` to supply a key explicitly. The optional
`deepseek_base_url` (or `DEEPSEEK_BASE_URL` environment variable) defaults to
`https://api.deepseek.com`. `api_request_timeout` defaults to 240 seconds.
Each agent's existing `*_model_name` parameter remains configurable.
Thinking mode is explicitly disabled to preserve temperature controls and use
the final-answer format expected by Voyager's code and JSON parsers.

The old `openai_api_key` argument remains a compatibility alias for a **DeepSeek**
key. The old `openai_api_request_timeout` argument also remains supported.
`OPENAI_API_KEY` and `OPENAI_API_BASE` are not used.

## Multiplayer connections

Connect directly to a Minecraft Java server with Microsoft authentication:

```bash
python run.py --mc-host play.example.com --mc-port 25565 \
  --mc-auth microsoft --mc-username 'your-account@example.com'
```

The terminal displays a Microsoft device sign-in link and code on first use.
Complete that login in your browser with an account that owns Minecraft Java.
No password is passed to Voyager. Sessions are cached in `.minecraft-auth/`
(ignored by Git) and reused on reconnect. Treat this folder as credentials;
delete it to clear the local login cache. `--mc-profiles-folder` selects another
cache location; keep any custom location outside version control.
Use a separate account if you want to play alongside the bot on the same server.
This uses [Mineflayer's Microsoft authentication](https://github.com/PrismarineJS/node-minecraft-protocol/blob/master/docs/API.md#mc-createclientoptions),
independently of the legacy `azure_login` local-world launcher.

For a LAN world or a server configured to accept offline players:

```bash
python run.py --mc-host 192.168.1.50 --mc-port 25565 \
  --mc-auth offline --mc-username VoyagerBot
```

Offline mode means **no Microsoft authentication**; it only works where the
server accepts offline clients. DeepSeek still needs internet access.
Omitting the new options preserves the existing local LAN connection as `bot`.
`--mc-version 1.19` pins the protocol; otherwise Mineflayer detects it.
The existing setup and skill library target Minecraft 1.19; newer protocol
support alone does not guarantee every generated skill works on newer releases.

The Python API accepts the same connection settings:

```python
voyager = Voyager(
    mc_host="play.example.com",
    mc_port=25565,
    mc_auth="microsoft",  # or "offline"
    mc_username="your-account@example.com",
    mc_pause_mode="none",
)
```

`mc_port` defaults to 25565 in the Python API when a non-default `mc_host` is
provided. `server_port` continues to mean the local HTTP bridge port, not the
Minecraft port. The HTTP bridge listens only on loopback.

Voyager's learning/reset workflow requires operator permissions for commands
such as `/clear`, `/kill`, `/give`, `/tp`, and `/gamerule`; connection support
does not remove that requirement. Whitelist the bot's actual in-game profile
name when required by the server.

Pause behavior is controlled with `--mc-pause-mode` (Python: `mc_pause_mode`):

- `auto` (default): the existing `/pause` mod for local offline connections;
  no pausing for remote or Microsoft connections.
- `none`: leave the server running while the agents think.
- `mod`: use the existing local `/pause` toggle mod.
- `tick`: send `/tick freeze` between steps and `/tick unfreeze` before actions,
  resets, and normal shutdown. Requires Java 1.20.3 or newer, sufficient OP
  permissions (vanilla level 3 or higher), and command feedback enabled:
  `sendCommandFeedback=true` before 1.21.11, or
  `minecraft:send_command_feedback=true` on 1.21.11+.

For example, append `--mc-pause-mode tick` to the Microsoft command above on a
compatible server. Tick mode waits for server command confirmation rather than
world ticks, reports denied commands, and attempts to undo a freeze if
confirmation fails. It freezes world simulation for everyone; players and their
mounts still move. See the [official 1.20.3 tick command documentation](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-3).
If the process is forcibly killed while frozen, an operator may need to run
`/tick unfreeze` manually.

## Saved skills and checkpoints

```bash
python run.py --mc-port 12345 --resume --ckpt-dir ckpt
```

For an existing skill library, use
`Voyager(mc_port=12345, skill_library_dir="skill_library/trial1")`.
On first load, local search indexes are rebuilt from `skill/skills.json` and
`curriculum/qa_cache.json` when applicable. They are saved in separate
`vectordb-local-minilm` directories, preserving the old OpenAI `vectordb`
directories. Code, descriptions, completed tasks, and cached answers are retained.
Retrieval rankings can differ because the embedding model has changed.

## Tests

```bash
python -m unittest discover -s tests -v
```

For the Node connection and pause tests:

```bash
cd voyager/env/mineflayer
npm test
```

Tests use a mocked HTTP transport, simulated bot events, and local synthetic embeddings; they do not
spend API credits, download embedding weights, or start Minecraft.
