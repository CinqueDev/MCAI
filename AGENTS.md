# In-game command help

When adding, changing, or removing player-facing chat controls, memory operations,
action capabilities, or chat preferences, update
`voyager/env/mineflayer/lib/commandCatalog.js` in the same change. This catalog
renders the in-game `cmds` response and registers direct command names and aliases.
Native tool definitions and examples live in `voyager/conversation_tools.json`;
update that registry alongside tool behavior. Prefer semantic tool calls over
adding required natural-language phrases. Retain immediate emergency controls.
Keep examples accurate about whether requests run directly or are interpreted by
the AI, including relevant gameplay limitations.

Run `node --test voyager/env/mineflayer/test/commandHelp.test.js` after changes.
Every action primitive must have a help entry, or an explicit explanation in
`INTERNAL_PRIMITIVES` if it only supports other helpers. Do not classify a
player-facing capability as internal to bypass the coverage check.
