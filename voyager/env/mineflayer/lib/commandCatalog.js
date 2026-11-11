const TOOL_CATALOG = require("../../../conversation_tools.json");
// Player-facing help and direct command names live here. Update this catalog when
// adding/removing controls, memory operations, or action primitives.
const CONTROLS = [
    { name: "cmds", aliases: ["commands", "help"], usage: "cmds (also commands/help)", description: "list commands and request examples" },
    { name: "stop", usage: "stop", description: "cancel active work and halt new work until resume" },
    { name: "pause", usage: "pause", description: "pause work, keeping progress" },
    { name: "resume", usage: "resume", description: "resume halted work" },
    { name: "cancel", usage: "cancel / cancel the current task / cancel task <id>", description: "cancel active or specified queued work" },
    { name: "status", usage: "status", description: "show current work", phrases: ["what are you doing"] },
    { name: "queue", usage: "queue", description: "list tasks and IDs", phrases: ["what's queue", "what's the queue", "what's task queue", "what's the task queue", "what is queue", "what is the queue", "what is task queue", "what is the task queue"] },
];
const MEMORY = [
    { op: "remember", examples: ["remember here as home", "save my location", "can you remember the location I am currently at?", "remember home at 100,64,-20 in the overworld"] },
    { op: "recall", examples: ["where is home?", "what do you remember about the kitchen chest?"] },
    { op: "rename", examples: ["rename home to cottage"] },
    { op: "correct", examples: ["actually, home is at 110,64,-20"] },
    { op: "forget", examples: ["forget home"] },
    { op: "notes", examples: ["remember I prefer spruce", "remember this chest belongs to Alice", "remember we finished the bridge", "remember there is coal at 100,64,-20"] },
];
const ACTIONS = [
    { primitive: "resolveTarget", example: "come behind me / go beside the chest I am looking at / go to home" },
    { primitive: "followPlayer", example: "follow me at 3 blocks / stop following / resume following" },
    { primitive: "stayAt", example: "stay here / stay at home" },
    { primitive: "moveToPlayer", example: "come here" },
    { primitive: "moveToPosition", example: "meet me at 100,64,-20" },
    { primitive: "waitForItem", example: "come here; I'll give you a pickaxe" },
    { primitive: "dropItem", example: "drop 8 cobblestone" },
    { primitive: "giveItemToPlayer", example: "give Alice one iron pickaxe" },
    { primitive: "placeItem", example: "place a crafting table at 100,64,-20" },
    { primitive: "removeBlockAt", example: "break only the beehive at 100,64,-20" },
    { primitive: "replaceBlockAt", example: "replace the dirt at 100,64,-20 with stone" },
    { primitive: "buildProjectBatch", example: "build/continue the house project; report missing materials; revise a paused blueprint" },
    { primitive: "buildStructure", example: "build a 5-wide, 3-high cobblestone wall starting at 100,64,-20" },
    { primitive: "mineBlock", example: "mine 16 coal" },
    { primitive: "craftItem", example: "craft a stone pickaxe" },
    { primitive: "smeltItem", example: "smelt 8 raw iron using coal" },
    { primitive: "useChest", example: "check / take 8 cobblestone from / deposit 8 cobblestone into the chest at 100,64,-20" },
    { primitive: "exploreUntil", example: "explore north for 30 seconds" },
    { primitive: "killMob", example: "attack the nearby zombie" },
    { primitive: "shoot", example: "shoot the nearby skeleton with a bow" },
];
// These files support other helpers and do not expose a separate chat request.
const INTERNAL_PRIMITIVES = {
    craftHelper: "crafting feedback and recipe lookup",
    waitForMobRemoved: "combat completion checks",
    givePlacedItemBack: "legacy cleanup helper, not a player command",
};
const SOCIAL = ["stay quiet for 10 minutes", "start chatting again"];

function renderCommandHelp(username) {
    return [
        `Commands for ${username}: say cmds in public or /msg ${username} cmds. No slash prefix needed in public.`,
        "[Immediate controls] " + CONTROLS.map(c => `${c.usage}: ${c.description}`).join("; ") + ".",
        "Control alternatives: what are you doing?; what's the queue?; stop building; cancel the current task; pause working; resume my task; continue working. Only requesters/operators control player tasks.",
        "[Memory requests] " + MEMORY.flatMap(m => m.examples).join("; ") + ".",
        "Current-location saves use YOUR loaded coordinates; no label saves as <player>'s saved location. Private memory stays private. If your position is unknown, provide coordinates and dimension.",
        "[Gameplay requests] " + ACTIONS.map(a => a.example).join("; ") + ".",
        "[Natural-language tools] " + TOOL_CATALOG.map(t => t.examples.join("; ")).join("; ") + ". No exact wording is required; work and memory changes are confirmed from actual tool results.",
        "[Chat preferences] " + SOCIAL.join("; ") + ". Private messages and public username mentions still require replies.",
        `Other than immediate controls and current-location saves, these are AI-interpreted request examples, not rigid commands. For a required reply, use /msg ${username} <request> or mention ${username} publicly. New work replaces your old follow/stay request unless you ask to resume following afterward. Work is queued and attempted; materials, visible targets and reachable locations are needed. Building needs size/materials/location (up to 128 blocks per batch); movement stays in the current dimension. Named projects persist versions/progress (up to 4096 cells, 64x64 across), preserve conflicting player edits, and support axis/slab/furnace-chest facing states.`,
    ].join("\n");
}
module.exports = { CONTROLS, MEMORY, ACTIONS, INTERNAL_PRIMITIVES, SOCIAL, renderCommandHelp };
