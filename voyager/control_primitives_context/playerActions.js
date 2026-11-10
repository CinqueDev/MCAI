// Cooperative actions use survival movement/items, without teleporting or giving items by command.
// Each helper returns structured verified evidence in status.actionResults, or throws on failure.
// Arrival uses a bounded path search. Missing loaded player entities require asking for coordinates.
// Never guess a distant player's location. Match their real username, ignoring case.
// Move to the player's CURRENT visible position, face them, then stop nearby (not permanent following).
async function moveToPlayer(bot, username, range = 2, timeoutMs = 30000) {}
// Walk to supplied x/y/z coordinates in this dimension. Accepts Vec3 or {x,y,z}; range 0-4.
async function moveToPosition(bot, position, range = 1, timeoutMs = 30000) {}
// Drop exactly count items from inventory, across stacks. Does not drop all of a stack by default.
async function dropItem(bot, name, count = 1) {}
// Approach and face a visible player, then drop items nearby. This does NOT confirm player pickup.
async function giveItemToPlayer(bot, username, name, count = 1) {}
// Build an explicit blueprint in order, supports first. Checks materials; never clears occupied cells.
// 1-128 blocks per batch. Larger structures need bounded batches; skip cells already matching.
// Example: await buildStructure(bot, [
//   {name: "cobblestone", position: {x: 10, y: 64, z: 20}},
//   {name: "cobblestone", position: {x: 11, y: 64, z: 20}}
// ]);
async function buildStructure(bot, blocks) {}
// Stop and wait for an inventory INCREASE of count matching items; timeout up to 120000 ms.
// Accept a name or array of alternatives (e.g. all pickaxe item names if material is unspecified).
// Call after approaching a player offering supplies so you do not immediately walk away.
// Does not identify who supplied the item, and throws on timeout.
async function waitForItem(bot, names, count = 1, timeoutMs = 30000) {}
// Resolve a target with explicit evidence or an unresolved/ambiguous reason. Reference types:
// player (name, omit for requester), current_location, behind_player (name), looked_block,
// beside_block (pointed block, optional block name), coordinates/block (position, dimension),
// landmark (name from scoped world memory), entity (name or entityId).
// Never turn unresolved results into guessed coordinates. No cross-dimension travel.
function resolveTarget(bot, reference) {}
// Resolve and walk to a reference, including behind a player or a remembered place.
async function moveToTarget(bot, reference, range = 1, timeoutMs = 30000) {}
// Start a PERSISTENT mode associated with this explicit player task. It takes over
// after this action returns: do not perform further gameplay operations afterward.
// Foreground requests temporarily yield this mode; it resumes when they finish.
// Use the controller's stop/pause/cancel controls; never create your own infinite loop.
async function followPlayer(bot, username, distance = 2) {}
// Hold the bot's current position, or resolve the supplied reference and hold there.
// For the requesting player's position: {type:'current_location'}.
async function stayAt(bot, reference = null) {}
