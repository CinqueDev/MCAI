const assert = require("node:assert/strict");
const mineflayer = require("mineflayer");
const { Movements } = require("mineflayer-pathfinder");
const { worldSetupCommands } = require("../lib/compatibility");

// This checks local client/data integration, without a server or AI requests.
const versions = process.argv.slice(2);
if (!versions.length) versions.push("1.19", "1.19.4", "1.20.1", "1.20.6",
    "1.21.1", "1.21.4", "1.21.8", "1.21.11", "26.1");

assert.equal(typeof require("../mineflayer-collectblock/lib").plugin, "function");
assert.equal(typeof require("mineflayer-tool").plugin, "function");
assert.equal(typeof require("mineflayer-pvp").plugin, "function");
assert.equal(typeof require("minecrafthawkeye").default, "function");

for (const version of versions) {
    const registry = require("prismarine-registry")(version);
    const protocol = registry.version.version;
    assert.ok(protocol <= require("minecraft-data")(mineflayer.latestSupportedVersion).version.version,
        `${version} is newer than this Mineflayer client supports`);
    const Block = require("prismarine-block")(registry);
    const Item = require("prismarine-item")(registry);
    const { Recipe } = require("prismarine-recipe")(registry);
    const stone = Block.fromStateId(registry.blocksByName.stone.minStateId, 0);
    assert.equal(stone.name, "stone");
    const pickaxe = new Item(registry.itemsByName.stone_pickaxe.id, 1);
    assert.equal(pickaxe.name, "stone_pickaxe");
    assert.ok(Recipe.find(pickaxe.type).length, "Stone pickaxe recipe is missing");
    const movements = new Movements({ registry });
    assert.ok(movements.blocksCantBreak.has(registry.blocksByName.chest.id));
    assert.equal(worldSetupCommands(version).length, 2);
    console.log(`PASS Java ${version}: blocks, items, recipes, pathfinder, setup commands`);
}
console.log(`Mineflayer ${require("mineflayer/package.json").version}; latest upstream target: ${mineflayer.latestSupportedVersion}`);
console.log("Dependency checks only; joining, movement, crafting and combat still need in-game validation.");
