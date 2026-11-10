const minecraftData = require("minecraft-data");

// Java 1.21.11 moved game rules to namespaced registry identifiers.
// Compare protocol numbers so the new 26.x version numbering also works.
function worldSetupCommands(version) {
    const data = minecraftData(version);
    if (!data) throw new Error(`No Minecraft Java data available for ${version}`);
    const renamedRules = data.version.version >= minecraftData("1.21.11").version.version;
    return renamedRules ? [
        "/gamerule minecraft:keep_inventory true",
        "/gamerule minecraft:advance_time false",
    ] : [
        "/gamerule keepInventory true",
        "/gamerule doDaylightCycle false",
    ];
}

module.exports = { worldSetupCommands };
