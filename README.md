# Voyager with DeepSeek

This fork of [MineDojo/Voyager](https://github.com/MineDojo/Voyager) uses
DeepSeek for Minecraft action generation, curriculum planning, question answering,
task verification, and skill descriptions. The agent clients default to
`deepseek-flash`, the current Flash API alias documented by
[DeepSeek](https://api-docs.deepseek.com/).

Skill and question retrieval use the local
`sentence-transformers/all-MiniLM-L6-v2` embedding model. No OpenAI account or
embedding API key is needed. The `openai` Python package is used only as the
OpenAI-compatible HTTP client for DeepSeek.

## Installation

Install Python **3.10 or 3.11** and **Node.js 22 or newer** (including npm).
Then, from the repository root, launch with:

```bash
python3 run.py
```

The launcher automatically creates `.venv` when needed, installs the Python
requirements, installs the Node dependencies and builds the collection plugin.
It uses the project's virtual environment automatically, even if you launch
with a different system Python. Python 3.10 or 3.11 must be available to create
that environment. First-time setup requires internet access; subsequent launches
reuse installed dependencies. Setup runs again only when dependency/build inputs
change or the project folder moves. Shell activation is not required.

Keep your settings in `config.json` and your API key in `.env` as described
below. If your terminal provides a `python` command, `python run.py` also works.
You do not need to rerun pip or npm after opening a new terminal.

For manual installation or development, the equivalent steps remain:

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -e .
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
  "mc_allow_world_changes": false,
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

Set `"mc_allow_world_changes": false` in `config.json`, pass
`--no-mc-allow-world-changes`, or use `Voyager(mc_allow_world_changes=False, ...)`
to preserve the server's tick, difficulty, time and gamerule settings. This
overrides every pause mode to `none`, skips startup gamerules and learning-reset
time/difficulty changes, and rejects those commands from generated actions too.
The default is `true` for compatibility. Restart the bot after changing the
setting; it does not restore settings changed by earlier runs. Player task
`stop`, `pause` and `resume` controls still work. Other operator commands used by
hard resets, such as inventory changes and teleportation, remain available.

## Playing and chatting with the agent

Conversation is enabled by default and runs separately from action generation, so
players can chat while the bot is mining, crafting, or waiting for a task decision.
Run normally with `python run.py`; no tag or chat command prefix is required.

- Ordinary public messages are optional: the agent may join in or remain silent.
- Any public message containing the bot's in-game username, anywhere and ignoring
  capitalization, requires a public reply. With Microsoft login this is the profile
  name, rather than the account email used to authenticate.
- Private messages sent through `/msg` or `/tell` require a private reply using
  `/msg <sender> ...`. Private routing takes priority over username mentions.
- Recent conversation includes senders, timestamps, channels, and the bot's replies.
  The agent can follow up without another mention, use the player's language,
  offer help, and occasionally initiate conversation. It receives online-player
  presence explicitly and never initiates public conversation while alone.
- Optional replies have a 20-second cooldown; opportunities to initiate are considered
  about every two minutes. Requests for quiet suppress optional conversation for up
  to an hour. Mandatory private replies and public mentions bypass those limits.
- Explicit requests for Minecraft work can be queued during `learn()`. They are
  attempted after the current action, with a completion/failure message in the original
  public/private channel. Asking a question or discussing a plan need not queue work.
  Active mining/combat is not interrupted mid-action.

The conversation model uses native DeepSeek tool calls for task status/control,
queuing Minecraft work, memory lookup/updates, world-reference resolution, and
persistent following/staying. Ordinary language selects these tools; you do not
need to memorize sentences. The application binds the caller and reply channel,
executes the tool, and feeds the receipt back to the model. Mutating tool receipts
supply the acknowledgement, so a failed cancellation cannot be reported as a
success. Short controls such as `stop` remain immediate even while a model call
is in progress. Native prompts use a chat-only final response schema; the legacy
JSON action format is supplied only to clients without native tool support. If a
native model returns that obsolete format, the worker requests one corrective
turn automatically and still requires a real, authorized tool call. It never
executes legacy fields directly or repeats an already confirmed mutation. Internal
diagnostics record protocol repairs and tool result status without logging private
message contents. The protocol follows [DeepSeek's tool-call documentation](https://api-docs.deepseek.com/guides/tool_calls/).

Incoming messages remain in a separate unprocessed inbox until answered or
acknowledged. Untagged work requests bypass optional social-chat cooldowns, and
later queue/status messages cannot discard an earlier request. Autonomous work
waits for input interpretation; queue/status can report that interpretation is
pending instead of implying that an action was already queued.

A separate semantic review checks plain-text answers against the original request
and actual tool receipts. An unsupported promise such as “On my way” triggers a
bounded corrective tool turn, just like obsolete action JSON. It does not become
a task by parsing fixed user phrases. Normal conversation remains optional; only
actual tool results confirm work. The review uses [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/)
and retries malformed review output once.

For new work, the social agent evaluates urgency and the current task using the
native tools' `scheduling` choice. `interrupt` asks to handle a quick or urgent
request next, temporarily yielding eligible current work; `queue` waits (also the
default when omitted). For example, “come here now, then continue mining” can
yield mining, while “finish first, then gather wood” stays queued. The controller
permits interruption of autonomous work or the same requester's work (operators
can also interrupt other work), and preserves explicit player pauses/stops.
Atomic transactions and blueprint cell receipts settle before switching. Old
model output is discarded without waiting for its API call. Saved work re-enters
the queue and replans from fresh observations, starting inventory and receipts;
it requires no manual resume. Continuous following/staying must end before the
old work can return. Tool replies report whether the switch was accepted or must
wait, rather than claiming the new action already happened.

Long replies are split into word-aware chunks and sent about 1.2 seconds apart.
Each private chunk uses `/msg` to the original sender; retries resume the same
reply instead of repeating chunks already sent.

Task control is handled directly by the Minecraft bridge, independently of model
latency. Use an exact command in public chat (optionally addressed to the bot) or
send it privately:

| Message | Effect |
| --- | --- |
| `cmds` / `commands` / `help` | List task controls, memory requests, gameplay examples and chat preferences. |
| `Voyager, stop` | Cancel the active task and halt new work until resumed. |
| `pause` | Pause the active task, keeping verified progress, and halt new work. |
| `resume` | Continue with fresh observations and a new execution generation. |
| `cancel` / `cancel task <id>` | Cancel the active task or a specific queued task. |
| `status` / `what are you doing?` | Report visible active work and completed action batches. |
| `queue` | List visible running, paused and queued tasks with short IDs. |

Say `cmds` publicly or send `/msg <bot_username> cmds` for the complete built-in
help. It works without the social model or an initialized task controller, uses
the incoming public/private channel, and splits long replies into paced messages.
The list distinguishes direct controls from AI-interpreted request examples.

Help is maintained in `voyager/env/mineflayer/lib/commandCatalog.js`; direct
command names and aliases are registered from that same catalog. Native tool
schemas and examples live in `voyager/conversation_tools.json`, which also feeds
the help response. Update it in the
same change as any player-facing capability. The command-help tests flag action
primitive files missing from the catalog, including newly added helpers.

Replace `Voyager` with the bot's actual username. Only exact controls are handled
this way; sentences discussing or quoting “stop” are not cancellation commands.
Private controls receive `/msg` responses. Public status/queue responses exclude
private task descriptions, including when requested by that task's owner.
Requesters control their own tasks; `task_operators` in configuration can list
usernames allowed to control other tasks. Any player can stop autonomous curriculum
work; only the player who paused/stopped work or an operator can resume that halt.
These direct controls remain available when the social model is disabled.

Disconnects during an action return a typed connection-loss response immediately,
even if an old inventory transaction has not settled. Chat polling can also detect
connection loss while an action-model call is pending. Scheduling also retries connection loss between readiness, claiming
work and updating planning state, so that race does not terminate the Python loop.
For `chat_validation_failed` kicks, the bridge logs the last eight outbound chat
packet metadata records (timing, length, signing flags and acknowledgement counts),
without message text, signature contents or credentials. This diagnostic does not
change chat signing or establish the server's reason for rejecting a packet.
Concurrent reconnects are serialized, and shutdown prevents queued reconnect attempts. Recovery rejoins softly and
uses the journal's receipts to reconcile interrupted item operations automatically. Local
errors never trigger inventory/position restoration or a hard reset. Event-record
filenames use a bounded task slug and hash so long construction requests cannot
fail with a filesystem filename-length error.

Task IDs, requesters, channels, priorities, lifecycle states, action IDs, operation
states and verified receipts are saved atomically under `<ckpt_dir>/tasks/`.
Journal files use the current host, login identifier and `world_id`, or the port
when no world ID is configured. Reuse the same checkpoint and identity for recovery.
Setting/changing an explicit world ID selects a separate task journal. Queued work survives restart;
safe previously running work is requeued automatically with a new execution
generation, fresh observations, and its prior action receipts. Explicit player
pauses/stops remain in effect. Interrupted drops/transfers and crafting/consumption
operations receive inventory recovery receipts and a fresh planning turn, without
globally halting work. Older checkpoints paused solely by inventory review or reconnect recovery are migrated
to this policy. Queue/status replies distinguish paused work from normal planning. Player
requests are dispatched while curriculum suggestions are generated in the background;
abandoned suggestions are discarded, including suggestions made before a movement mode changed execution state. Resume replans against observations and
prior receipts, rather than continuing an old JavaScript stack.

Cancellation is cooperative: movement and bounded waits are interrupted; an
in-flight inventory transaction settles before another operation can start.
Completed placements/drops are retained. A failed or crash-interrupted inventory
operation is reconciled against its saved before/after inventory and, on reconnect,
the live inventory. Recovery evidence is included in the next action-agent context.
Known partial toss/withdraw/deposit quantities allow only the remaining quantity;
unknown outcomes block replay of that operation within that task. The agent must
verify delivery where possible, replan, or report a specific unresolved limitation;
inventory loss alone does not prove that a player received items. Older journals
without item details cannot establish quantities, so their uncertain operations
remain guarded while other work can proceed. Controls also
invalidate pending model output and old asynchronous movement callbacks. Arbitrary
synchronous generated JavaScript that blocks Node's event loop cannot be preempted
by this controller; helpers and generated programs must remain bounded.

Movement danger pauses continue automatically once health is above 6 and the bot
is out of lava; reconnecting does not bypass an ongoing danger or a player's stop.

Chat requests now have explicit action helpers:

| Request | Helper | Behavior |
| --- | --- | --- |
| “Follow me at 3 blocks” | `followPlayer(bot, username, distance)` | Continuous following until stopped, interrupted by danger, or the player is lost. |
| “Stay here” / “stay at home” | `stayAt(bot, reference)` | Hold a resolved position until stopped or superseded by new work. |
| “Come behind me” / “beside that chest” / “go home” | `resolveTarget` / `moveToTarget` | Resolve a typed reference or ask for clarification; never invent an unseen target. |
| “Come here” | `moveToPlayer(bot, username)` | Walk to a currently visible player and face them. |
| “Meet me at 100, 64, -20” | `moveToPosition(bot, position)` | Walk to coordinates in the current dimension. |
| “I'll give you a pickaxe” | `waitForItem(bot, names, count, timeoutMs)` | Stop and wait briefly for an inventory increase after approaching. |
| “Drop 8 cobblestone” | `dropItem(bot, name, count)` | Drop exactly that amount from inventory, including across stacks. |
| “Give Alice a pickaxe” | `giveItemToPlayer(bot, username, name, count)` | Approach, face the player, and drop the item nearby. |
| “Place a crafting table here” | `placeItem(bot, name, position)` | Place at an exact integer coordinate, then verify the world block. |
| “Build a wall here” | `buildStructure(bot, blocks)` | Execute an explicit supported blueprint, up to 128 blocks per batch. |
| “Break only that beehive” | `removeBlockAt(bot, position, expected)` | Remove the exact resolved cell with tool/reach/result checks. |
| “Replace this dirt with stone” | `replaceBlockAt(bot, position, expected, name, state)` | Replace only the specified cell and report partial results. |
| “Continue the house project” | `buildProjectBatch(bot, projectId, limit)` | Reconcile saved progress and execute a bounded batch of its approved plan. |

The social agent and action planner receive current visible player coordinates,
dimension, and inventory. Players outside loaded chunks have unknown locations;
the bot must ask for coordinates instead of inventing them. Vague build requests
need a location, size and materials. These helpers do not implement portal travel.
Walking to players does not dig through buildings or place temporary scaffolding;
paths have bounded timeouts and failures are reported. Giving verifies the drop,
not that the intended player picked it up. Building requires real inventory items,
solid supports and empty target cells; it can resume by skipping matching blocks.
Blueprints can specify the limited verified states described below.

Persistent follow/stay modes use the durable task controller's movement lease.
Foreground player work has priority over these modes; autonomous curriculum waits.
A new foreground request from the same player supersedes their old mode, including
modes still waiting in the queue. If the player explicitly asks to follow again
after the work, the tool sets `resume_following=true`; the mode then yields and
resumes afterward. Other players' work temporarily yields a mode without cancelling
its owner's request. When a new work request needs details, the agent can stop the
requester's old movement and ask its clarification through `prepare_work` in the
movement tool; it does not queue a speculative task. Safe modes still recover
automatically after reconnect.
You can pause/stop/cancel it, or ask to stop/resume following in ordinary language.
Following stops moving immediately when the loaded player disappears, waits up to
15 seconds for them to reappear, and reports a lost player if they remain absent.
A route with no progress for 30 seconds fails clearly. Low health/lava pauses the
mode for safety. Modes do not tunnel through buildings or place scaffolding.

The shared resolver supports players, request-time “here”, coordinates, behind a
loaded player, pointed-at blocks/faces, supported spaces beside blocks, loaded
entities and remembered landmarks. Pointing requires a loaded player's observed
head direction and eye height and uses a bounded 6-block raycast through loaded
chunks. Ambiguous entities/landmarks, stale memory, unknown dimensions and
cross-dimension targets require clarification. Native target tools and generated
actions receive only memory visible in their original public/private scope.

Named projects now support durable exact-cell builds and edits. Ask in ordinary
language to create a named wall/house, continue it, check missing materials, revise
its paused blueprint, or gather the next batch of supplies. The model uses
`create_project`, `revise_project`, `continue_project`, `project_status` and
`project_supplies`; no specific chat phrase is required. A build request can save
and queue its concrete plan in one operation. Requests to plan without building
use `execute=false`. Bounds, location and materials must be clear before queuing.

Project blueprints contain explicit cells relative to a resolved origin, with
optional support dependencies and explicit expected-block removals/replacements.
The journal retains up to eight blueprint versions and verified per-cell progress
under the original world and public/private scope. Limits are 4096 cells and a
64-by-64 horizontal footprint, within build height. Construction runs in cancellable
batches of at most 128 cells. Saved project state is not stored as an executable
skill, and a critic cannot declare a partial batch to be a completed build.

`removeBlockAt(bot, position, expected)` digs only the exact requested cell with
reach/tool checks and verifies its removal. `replaceBlockAt(bot, position,
expected, name, state)` checks replacement inventory before digging and reports a
partial failure if placement fails. Supported placement states are axis, single
slab top/bottom, and horizontal furnace/chest facing. Arbitrary stair/redstone
states and multi-cell project doors/beds/tall plants are unsupported. Default
placements still verify the resulting block. No teleporting, material grants,
implicit clearing, or automatic deletion of retired blueprint cells is used.

Resume/rejoin rechecks saved cells. Already matching blocks consume no further
items; player changes to verified cells and uncertain absent placements stop the
project with a conflict. The bot preserves those edits. An explicit revised
blueprint can authorize a replacement for a particular conflicting cell; pause
active construction and let its current block operation settle before revising.
A plan-only revision cancels unfinished execution without undoing completed blocks.

Material queries show totals and current shortages. A restocking request queues
at most 64 of each item and 128 items total, followed by construction dependent on
successful supplies. A failed supply task blocks its dependent build; an explicit
continue request can retry construction with newly obtained inventory. Existing
or learned gathering/crafting/container workflows perform supply tasks. Phase 4
container/interaction hardening was deferred to agent learning, not implemented
as part of these project tools. Private project plans stay private. World memory
mirrors project summaries and labels unbuilt plans separately from verified builds.

Each helper records structured action evidence for the planner and task critic, so
successful interactions can be checked against the requested coordinates, player,
item and quantity. The legacy automatic cleanup that deleted nearby workstations
and granted replacement supplies after each step has been removed. Placed crafting
tables/furnaces remain in the world. Chat tasks also skip time/difficulty setup and
teleport recovery. The original hard reset and other curriculum setup commands
still require operator permissions as documented above.

The conversation worker uses the configured action model and DeepSeek credentials,
with its own client and a 30-second maximum request timeout. It polls locally every
two seconds; polling does not call the model. Model calls occur for incoming chat or
periodic opportunities to initiate while players are online, and consume API credits.
If generation fails for a mandatory message, it sends a brief failure acknowledgement.
Delivery retries use an idempotency key to avoid repeating a reply.

World knowledge is stored in `<ckpt_dir>/memory/world.sqlite3` and shared by the
conversation agent, action planner, curriculum planner and task critic. It includes
places, resources, storage, experiences, projects, player preferences and ownership
instructions. Executable learned skills remain separate.

Set a stable `"world_id": "survival-main"` in your configuration (or use
`--world-id survival-main`) to keep knowledge when a LAN port changes. Choose a new
ID for a new/reset world. Namespaces also include the server hostname and bot's
configured login identity. Without a world ID, the port supplies the fallback
identity; the bot cannot detect a world reset automatically. Set the intended ID
before the first run with structured memory so migration claims the right world.

Each fact has a record ID, dimension, visibility, provenance, evidence, observation
and verification times, and freshness information. Public facts are shared; private
facts belong to a player and are retrieved only for that player's private
conversation or associated private task. Known player UUIDs preserve private notes
across username changes, with a scoped username fallback until a UUID is available.
Raw private telemetry is not inserted into public prompts. New private task code
and descriptions are also excluded from the shared learned-skill library and
public curriculum progress lists. A later passive scan
also cannot publish a discovery originally recorded during private work.

The bot can learn without chatting: loaded block scans record resource/landmark
sightings and lava hazards, inspections record real container contents, failures and
deaths become experiences, and verified action receipts preserve construction
progress and task outcomes. Scans discover up to 32 relevant blocks within 24 blocks and recheck at most 512
tracked locations, at most once every five seconds. They do not infer that a bell proves a village or
that a failed route can never work. Project memory currently preserves up to 1024
verified cells and recent receipts; the persistent project execution workflow is a
later phase.

Changing knowledge is marked stale rather than assumed permanent. Resource sightings
expire after 30 minutes, container contents after five minutes, and place sightings
after one day. These are freshness labels, not automatic deletion. Preferences,
ownership notes and project progress remain until changed or forgotten. Block
changes invalidate matching sightings, and older events cannot overwrite fresher
inspection results. A reported/inferred fact never becomes verified just because a
model repeats it.

Explicit requests such as “save my coords as home” stay pending until answered,
even without mentioning the bot. The bot uses your loaded player coordinates
captured when the request arrives and confirms the coordinates read back from
memory. If your entity is unavailable, it asks for coordinates rather than using
its own position. Requests such as “Can you remember the location I am currently
at?” need no label: they save as `<player>'s saved location`, replacing that
player's previous default saved location in the same conversation scope and
dimension. Explicit labels such as “home” remain separate.

Examples of memory-only chat requests:

- “Remember here as home.” The location comes from the requesting player's loaded
  entity, captured when the message arrives, with a loaded-entity fallback if
  the tab-list link is missing. In native-tool mode the model calls `remember_location`; captured coordinates
  are resolved by the application without requiring a particular phrase. If your position remains unknown, it asks for coordinates.
- “Remember home at 100, 64, -20.” This is saved as a player report, not a direct observation. If the player is
  not visible and supplies no dimension, the dimension remains unknown.
- “What do you remember about the kitchen chest?”
- “Rename that chest to kitchen supplies.” Naming an observed object creates a
  reported alias linked to the original observation, preserving its evidence.
- “Actually, home is at 110, 64, -20.”
- “Forget home.” This removes the selected fact and derived summaries from active
  retrieval. Tombstones prevent the same automatic source/import from restoring it.

The model chooses structured memory operations and may ask which fact you mean.
The application checks scope, authorship, explicit edit/forget intent, and supplied
coordinates before applying them. Private edits stay private; a private request may
also forget the player's own public fact without publishing the deletion request.
Operators can edit public notes, but cannot retrieve another player's private notes.
Memory changes are applied before sending the acknowledgement. Ambiguous names need
clarification. World-reference tools resolve supported concrete references; unavailable
head direction or unloaded targets still require coordinates.

Existing `conversation/memory.json` notes and `action/chest_memory.json` entries are
imported once into the first active namespace. Originals are preserved as backups
and are no longer active stores. Imported notes have unknown original timestamps and are explicitly unverified.
The old chest cache has no reliable visibility or dimension metadata, so its
imported records are quarantined outside active retrieval; reinspection supplies
properly scoped current facts. Import fingerprints prevent a backup
from being imported into another world or restoring forgotten notes. Forgetting
removes active memory and dependent summaries; it does not erase original backup
files, Minecraft chat history, or existing action/task logs.

SQLite serializes updates from execution and conversation, keeps at most 2000 raw
evidence episodes per world, and uses bounded keyword/location retrieval; there is
no vector database or extra model call for memory ingestion. Recent chat remains a
separate bounded in-memory history and clears on reconnect. Live Minecraft behavior
and model choices still need gameplay validation.

Action progress and helper errors now use internal `bot.log` diagnostics. Existing
learned skills' non-command `bot.chat` calls are also redirected internally, preserving
the action agent's feedback without sending it to players. Conversation sends use a
separate bridge route with enforced reply channels and command rejection.

To disable conversation, set `"chat_enabled": false` in `config.json` or run
`python run.py --no-chat-enabled`. Internal action logging remains enabled.
The Python API also accepts `Voyager(..., chat_enabled=False)`.

The task client tolerates brief bridge initialization gaps. If Minecraft disconnects
while waiting for queued or paused work, it attempts one soft reconnection without
clearing inventory or teleporting to saved coordinates. Server kick/disconnect
reasons are logged, and startup failures are reported before a successful connection
is published.

Automated tests simulate messages and transport failures. Actual multiplayer chat,
server-specific chat plugins, timing during gameplay, and social behavior still need
an in-game check; the default input adapters support vanilla translated messages and
Mineflayer's public/whisper events.

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
