const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Vec3 } = require("vec3");
const { Movements, goals: { GoalNear, GoalFollow, GoalPlaceBlock } } = require("mineflayer-pathfinder");
const mcData = require("minecraft-data")("1.21.11");
const Block = require("prismarine-block")(mcData);
const { playerState } = require("../lib/playerState");

function scene(inventory = []) {
    const cells = new Map();
    const stacks = inventory.map(([name, count], slot) => ({ name, count, type: mcData.itemsByName[name].id, metadata: 0, slot }));
    const bot = {
        registry: mcData, game: { dimension: "overworld", minY: -64, height: 384 },
        username: "Voyager", entity: { position: new Vec3(0, 64, 0) }, players: {},
        actionResults: [], commands: [], saved: [], controls: {}, pathCalls: [],
        chat(text) { this.commands.push(text); }, log() {}, save(event) { this.saved.push(event); },
        clearControlStates() { this.controls = {}; },
        getControlState(name) { return this.controls[name] || false; },
        setControlState(name, value) { this.controls[name] = value; },
        inventory: { items: () => stacks.filter(s => s.count > 0) },
        async equip(item) { this.heldItem = item; }, async lookAt(position) { this.lookTarget = position; },
        async toss(type, metadata, count) {
            for (const stack of stacks) {
                if (stack.type !== type || stack.metadata !== metadata) continue;
                const amount = Math.min(count, stack.count);
                stack.count -= amount;
                count -= amount;
                if (!count) return;
            }
            throw new Error("Not enough items");
        },
        blockAt(position) {
            const name = cells.get(position.toString()) || (position.y < 64 ? "stone" : "air");
            const block = Block.fromStateId(mcData.blocksByName[name].minStateId, 0);
            block.position = position.clone();
            return block;
        },
        async placeBlock(reference, face) {
            cells.set(reference.position.plus(face).toString(), this.heldItem.name);
            this.heldItem.count--;
        },
    };
    bot.world = { getBlock: position => bot.blockAt(position) };
    bot.pathfinder = {
        movements: new Movements(bot),
        setMovements(movements) { this.movements = movements; },
        setGoal(goal) { this.goal = goal; },
        async goto(goal) {
            bot.pathCalls.push({ goal, movements: this.movements });
            if (goal instanceof GoalPlaceBlock) bot.entity.position = goal.pos.offset(2, 0, 0);
            else bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        },
    };
    const files = ["moveToPosition", "moveToPlayer", "dropItem", "giveItemToPlayer", "placeItem", "buildStructure", "waitForItem"];
    const code = files.map(name => fs.readFileSync(path.join(__dirname, "../../../control_primitives", name + ".js"), "utf8")).join("\n");
    const context = vm.createContext({ Vec3, Movements, GoalNear, GoalFollow, GoalPlaceBlock, mcData, setTimeout, clearTimeout, bot });
    vm.runInContext(code, context);
    return { bot, stacks, cells, run: code => vm.runInContext(code, context) };
}

test("walks to supplied coordinates, verifies arrival and restores nondestructive movement", async () => {
    const { bot, run } = scene();
    const previous = bot.pathfinder.movements;
    const result = await run("moveToPosition(bot, {x: 10, y: 64, z: 20})");
    assert.equal(result.verified, true);
    assert.equal(bot.entity.position.x, 10);
    assert.equal(bot.pathCalls[0].movements.canDig, false);
    assert.equal(bot.pathCalls[0].movements.allow1by1towers, false);
    assert.equal(bot.pathCalls[0].movements.scafoldingBlocks.length, 0);
    assert.equal(bot.pathfinder.movements, previous);
    assert.deepEqual(bot.commands, []);
});

test("visits a visible player and does not invent distant coordinates", async () => {
    const { bot, run } = scene();
    bot.players = { Alice: { username: "Alice", entity: { position: new Vec3(20, 64, 10) } }, Bob: { username: "Bob" } };
    const result = await run('moveToPlayer(bot, "alice")');
    assert.equal(result.player, "Alice");
    assert.equal(result.type, "approach_player");
    assert.ok(bot.lookTarget);
    await assert.rejects(run('moveToPlayer(bot, "Bob")'), /coordinates/);
    assert.equal(playerState(bot).find(p => p.username === "Bob").position, null);
    assert.equal(playerState(bot).find(p => p.username === "Alice").position.x, 20);
});

test("false arrival never records success and navigation timeout cancels the goal", async () => {
    const { bot, run } = scene();
    bot.pathfinder.goto = async () => {};
    await assert.rejects(run("moveToPosition(bot, {x: 30, y: 64, z: 0})"), /without reaching/);
    bot.pathfinder.goto = () => new Promise(() => {});
    await assert.rejects(run("moveToPosition(bot, {x: 30, y: 64, z: 0}, 1, 5)"), /timed out/);
    assert.equal(bot.pathfinder.goal, null);
    assert.equal(bot.actionResults.length, 0);
});

test("drops exact quantities across stacks and rejects shortages before mutation", async () => {
    const { bot, run, stacks } = scene([["cobblestone", 2], ["cobblestone", 4]]);
    const result = await run('dropItem(bot, "cobblestone", 5)');
    assert.equal(result.count, 5);
    assert.equal(stacks.reduce((sum, s) => sum + s.count, 0), 1);
    await assert.rejects(run('dropItem(bot, "cobblestone", 2)'), /nothing was dropped/);
    await assert.rejects(run('dropItem(bot, "cobblestone", -1)'), /positive integer/);
    assert.equal(bot.inventory.items()[0].count, 1);
});

test("giving approaches and drops without claiming player pickup", async () => {
    const { bot, run } = scene([["stone_pickaxe", 1]]);
    bot.players.Alice = { username: "Alice", entity: { position: new Vec3(10, 64, 10) } };
    const result = await run('giveItemToPlayer(bot, "Alice", "stone_pickaxe", 1)');
    assert.equal(result.type, "give");
    assert.equal(result.player, "Alice");
    assert.equal(result.pickupConfirmed, false);
    assert.equal(bot.inventory.items().length, 0);
});

test("placement verifies the exact cell and skips matching blocks on retry", async () => {
    const { bot, run, cells } = scene([["crafting_table", 1]]);
    const result = await run('placeItem(bot, "crafting_table", {x: 4, y: 64, z: 4})');
    assert.equal(result.verified, true);
    assert.equal(cells.get(new Vec3(4, 64, 4).toString()), "crafting_table");
    assert.equal(bot.getControlState("sneak"), false);
    const repeated = await run('placeItem(bot, "crafting_table", {x: 4, y: 64, z: 4})');
    assert.equal(repeated.alreadyPresent, true);
    assert.equal(bot.saved.length, 1);
});

test("placement protects occupied cells and rejects unsupported or unconfirmed placement", async () => {
    const { bot, run, cells } = scene([["cobblestone", 3]]);
    cells.set(new Vec3(4, 64, 4).toString(), "chest");
    await assert.rejects(run('placeItem(bot, "cobblestone", {x: 4, y: 64, z: 4})'), /already occupies/);
    await assert.rejects(run('placeItem(bot, "cobblestone", {x: 10, y: 70, z: 10})'), /No solid support/);
    bot.placeBlock = async () => {};
    await assert.rejects(run('placeItem(bot, "cobblestone", {x: 8, y: 64, z: 8})'), /not confirmed/);
    assert.ok(!bot.actionResults.some(r => r.type === "place" && r.verified));
});

test("builds and verifies a supported blueprint with an idempotent retry", async () => {
    const { bot, run } = scene([["cobblestone", 2]]);
    const code = 'buildStructure(bot, [{name:"cobblestone", position:{x:4,y:64,z:4}}, {name:"cobblestone",position:{x:4,y:65,z:4}}])';
    const result = await run(code);
    assert.equal(result.type, "build");
    assert.equal(result.blocks, 2);
    await run(code);
    assert.equal(bot.inventory.items().length, 0);
    assert.equal(bot.saved.length, 2);
});

test("build preflight catches missing materials, collisions and duplicate cells", async () => {
    const { bot, run, cells } = scene([["cobblestone", 1]]);
    await assert.rejects(run('buildStructure(bot, [{name:"cobblestone",position:{x:4,y:64,z:4}}, {name:"cobblestone",position:{x:5,y:64,z:4}}])'), /Gather materials/);
    await assert.rejects(run('buildStructure(bot, [{name:"cobblestone",position:{x:4,y:64,z:4}}, {name:"cobblestone",position:{x:4,y:64,z:4}}])'), /Duplicate/);
    cells.set(new Vec3(4, 64, 4).toString(), "chest");
    await assert.rejects(run('buildStructure(bot, [{name:"cobblestone",position:{x:4,y:64,z:4}}])'), /overwrite chest/);
    assert.equal(bot.saved.length, 0);
});

test("waits for an inventory increase, and times out without claiming receipt", async () => {
    const { run, stacks } = scene([["stone_pickaxe", 1]]);
    const receiving = run('waitForItem(bot, ["stone_pickaxe", "iron_pickaxe"], 1, 1000)');
    setTimeout(() => stacks.push({ name: "iron_pickaxe", count: 1 }), 5);
    const result = await receiving;
    assert.equal(result.type, "receive");
    assert.equal(result.count, 1);
    await assert.rejects(run('waitForItem(bot, "diamond_pickaxe", 1, 5)'), /inventory increase/);
});

test("partial drops expose the observed loss so retries can avoid giving too much", async () => {
    const { bot, run, stacks } = scene([["cobblestone", 2], ["cobblestone", 4]]);
    let calls = 0;
    const toss = bot.toss.bind(bot);
    bot.toss = async (...args) => {
        if (++calls === 2) throw new Error("connection interrupted");
        return toss(...args);
    };
    await assert.rejects(run('dropItem(bot, "cobblestone", 5)'), /decreased by 2 of 5/);
    assert.equal(bot.actionResults.at(-1).verified, false);
    assert.equal(bot.actionResults.at(-1).observedInventoryDecrease, 2);
    assert.equal(stacks.reduce((sum, s) => sum + s.count, 0), 4);
});
