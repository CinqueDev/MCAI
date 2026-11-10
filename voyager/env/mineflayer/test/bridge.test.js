const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

// Exercise real route handlers without Minecraft, plugins, or a listening socket.
function bridge({ initError = null } = {}) {
    const routes = {};
    const bots = [];
    const options = [];
    const app = { use() {}, post(route, handler) { routes[route] = handler; }, listen() {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../index.js"), "utf8"), {
        setTimeout, clearTimeout, console, process: Object.assign(new EventEmitter(), { argv: [] }),
        require(name) {
            if (["minecraft-data", "mineflayer-pathfinder", "vec3"].includes(name)) return require(name);
            if (name === "express") return () => app;
            if (name === "body-parser") return { json() {}, urlencoded() {} };
            if (name === "./lib/worldObservations") return require("../lib/worldObservations");
            if (name === "./lib/targetResolver") return require("../lib/targetResolver");
            if (name === "./lib/tasks") return require("../lib/tasks");
            if (name === "./lib/conversation") return require("../lib/conversation");
            if (name === "./lib/connection") return require("../lib/connection");
            if (name === "./lib/pause") return require("../lib/pause");
            if (name === "./lib/utils") return { initCounter() { if (initError) throw new Error(initError); } };
            if (name === "./lib/compatibility") return { worldSetupCommands: () => [] };
            if (name === "./lib/observation/base") return { inject(bot) { bot.observe = () => "observation"; } };
            if (name === "./lib/skillLoader") return { inject() {} };
            if (name === "mineflayer") return { createBot(settings) {
                options.push(settings);
                const bot = new EventEmitter();
                bot.end = () => bot.emit("end", "closed");
                const chat = (command) => {
                    bot.commands.push(command);
                    queueMicrotask(() => bot.emit("message", { json: { translate:
                        command === "/tick freeze" ? "commands.tick.status.frozen" : "commands.tick.status.running",
                    } }));
                };
                // Real createBot returns before chat is installed. Model that
                // lifecycle so startup tests catch premature bot.chat.bind().
                bot.finishLogin = () => {
                    bot.chat = chat;
                    bot.username = settings.username || "bot";
                    bot.version = "1.21.11";
                    bot.inventory = { items: () => [] };
                    bot.loadPlugin = () => {};
                    bot.waitForTicks = async () => {};
                    bot.emit("spawn");
                };
                bot.commands = [];
                bots.push(bot);
                return bot;
            } };
            return {};
        },
    });
    return { routes, bots, options, async spawn(index = 0) {
        bots[index].finishLogin();
        await new Promise(setImmediate);
    } };
}
function response() {
    return { headersSent: false, statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { assert.equal(this.headersSent, false); this.value = value; this.headersSent = true; },
    };
}

test("start forwards remote settings and kick replies with useful failure", () => {
    const { routes, bots, options } = bridge();
    const res = response();
    routes["/start"]({ body: { host: "example.org", port: 25565, username: "Voyager", auth: "offline" } }, res);
    assert.equal(options[0].host, "example.org");
    bots[0].emit("kicked", "Not whitelisted");
    assert.equal(res.statusCode, 400);
    assert.equal(res.value.error, "Not whitelisted");
});

test("late end from previous bot does not erase a new connection", async () => {
    const { routes, bots, spawn } = bridge();
    const body = { port: 25565, pauseMode: "tick" };
    routes["/start"]({ body }, response());
    routes["/start"]({ body }, response());
    await spawn(1);
    bots[0].emit("end", "late close");
    const paused = response();
    await routes["/pause"]({ body: { mode: "tick", paused: true } }, paused);
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.value.paused, true);
    const repeated = response();
    await routes["/pause"]({ body: { mode: "tick", paused: true } }, repeated);
    assert.equal(bots[1].commands.length, 1);
    await routes["/pause"]({ body: { mode: "tick", paused: false } }, response());
    assert.deepEqual(bots[1].commands, ["/tick freeze", "/tick unfreeze"]);
});

test("chat routes operate independently and enforce the incoming private channel", async () => {
    const { routes, bots, spawn } = bridge();
    routes["/start"]({ body: { port: 25565 } }, response());
    await spawn();
    const bot = bots[0];
    bot.username = "Voyager";
    bot.players = { Alice: {}, Voyager: {} };
    bot.emit("whisper", "Alice", "Voyager hello");
    const inbox = response();
    routes["/chat"]({ body: {} }, inbox);
    const { session, pending } = inbox.value;
    const out = response();
    await routes["/chat"]({ body: { session, replyTo: pending[0].id, key: "1", recipient: "Bob", text: "Hello" } }, out);
    assert.equal(out.value.delivered, true);
    assert.deepEqual(bot.commands, ["/msg Alice Hello"]);
    await routes["/chat"]({ body: { session, replyTo: pending[0].id, key: "1", text: "Hello" } }, response());
    assert.equal(bot.commands.length, 1);
});

test("fresh observations preserve the bot and are unavailable before spawn", () => {
    const { routes, bots } = bridge();
    const missing = response();
    routes["/observe"]({ body: {} }, missing);
    assert.equal(missing.statusCode, 409);
    routes["/start"]({ body: { port: 25565 } }, response());
    bots[0].entity = {};
    bots[0].observe = () => "fresh observation";
    const out = response();
    routes["/observe"]({ body: { waitTicks: 10 } }, out);
    assert.equal(out.value, "fresh observation");
    assert.equal(bots[0].waitTicks, 10);
});


test("conversation waits for chat initialization and is not rebound on respawn", async () => {
    const { routes, bots, spawn } = bridge();
    const started = response();
    assert.doesNotThrow(() => routes["/start"]({ body: { port: 25565, reset: "soft" } }, started));
    const bot = bots[0];
    assert.equal(bot.chat, undefined);
    assert.equal(bot.conversation, undefined);
    const waiting = response();
    routes["/chat"]({ body: {} }, waiting);
    assert.equal(waiting.statusCode, 409);
    await spawn();
    assert.equal(started.statusCode, 200);
    assert.equal(started.value, "observation");
    const session = bot.conversation;
    bot.emit("spawn");
    assert.equal(bot.conversation, session);
    bot.chat("/time set day");
    assert.deepEqual(bot.commands, ["/time set day"]);
});


test("player action steps preserve workstations and do not grant replacement inventory", async () => {
    const { routes, bots } = bridge();
    routes["/start"]({ body: { port: 25565 } }, response());
    bots[0].finishLogin();
    await new Promise(resolve => setImmediate(resolve));
    const bot = bots[0];
    bot.registry = require("minecraft-data")("1.21.11");
    bot.entity = { position: new (require("vec3").Vec3)(0, 64, 0) };
    bot.findBlock = () => ({ name: "crafting_table", position: bot.entity.position });
    bot.actionResults = [{ type: "old" }];
    let movements;
    bot.pathfinder = { setMovements(value) { movements = value; }, isMoving: () => false };
    bot.commands.length = 0;
    const result = response();
    await routes["/step"]({ body: { code: "bot.log('finished player action');", programs: "", playerRequest: true } }, result);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(bot.commands, []);
    assert.equal(bot.actionResults.length, 0);
    assert.equal(movements.canDig, false);
    assert.equal(movements.scafoldingBlocks.length, 0);
});

test("private stop interrupts an active generated action through the real bridge route", async () => {
    const { routes, bots } = bridge();
    routes["/start"]({ body: { port: 25565 } }, response());
    bots[0].finishLogin();
    await new Promise(resolve => setImmediate(resolve));
    const bot = bots[0];
    bot.registry = require("minecraft-data")("1.21.11");
    bot.pathfinder = { setMovements() {}, setGoal() {}, isMoving: () => false };
    bot.clearControlStates = () => {};
    const task = bot.tasks.enqueue({ task: "Wait for Alice", requester: "Alice", recipient: "Alice" });
    bot.tasks.claim(task.id);
    const res = response();
    const step = routes["/step"]({ body: { execution: { id: task.id, generation: task.generation },
        programs: "", code: "await bot.taskSleep(60000);", playerRequest: true } }, res);
    await new Promise(resolve => setImmediate(resolve));
    bot.emit("whisper", "Alice", "stop");
    await step;
    assert.equal(res.statusCode, 200);
    assert.equal(task.state, "cancelled");
    assert.equal(task.actions[0].state, "interrupted");
    assert.equal(bot.tasks.lease, null);
    assert.ok(bot.commands.some(text => text.startsWith("/msg Alice Stopped")));
});

test("tasks distinguish initialization from a lost Minecraft connection", async () => {
    const { routes, bots, spawn } = bridge();
    routes["/start"]({ body: { port: 25565 } }, response());
    const waiting = response();
    await routes["/tasks"]({ body: { operation: "snapshot" } }, waiting);
    assert.equal(waiting.value.code, "BOT_STARTING");
    await spawn();
    const ready = response();
    await routes["/tasks"]({ body: { operation: "snapshot" } }, ready);
    assert.equal(ready.statusCode, 200);
    bots[0].emit("kicked", "Server closed the connection");
    const ended = response();
    await routes["/tasks"]({ body: {} }, ended);
    assert.equal(ended.value.code, "BOT_DISCONNECTED");
    assert.match(ended.value.error, /Server closed/);
});

test("a setup failure cannot publish a successful start followed by an empty controller", async () => {
    const { routes, spawn } = bridge({ initError: "Missing startup clock" });
    const started = response();
    routes["/start"]({ body: { port: 25565 } }, started);
    await spawn();
    assert.equal(started.statusCode, 400);
    assert.match(started.value.error, /Missing startup clock/);
    const tasks = response();
    await routes["/tasks"]({ body: {} }, tasks);
    assert.equal(tasks.value.code, "BOT_DISCONNECTED");
});

test('multipart chat stays pending across HTTP polls and sends each private chunk once', async () => {
    const { routes, bots, spawn } = bridge();
    await routes['/start']({ body: { port: 25565 } }, response());
    await spawn();
    const bot = bots[0];
    bot.emit('whisper', 'Alice', 'please explain');
    const payload = { session: bot.conversation.session, replyTo: 1, key: 'multipart', text: 'a'.repeat(500) };
    const first = response();
    await routes['/chat']({ body: payload }, first);
    assert.equal(first.value.pending, true);
    assert.equal(bot.conversation.pending.size, 1);
    const second = response();
    await routes['/chat']({ body: payload }, second);
    assert.equal(second.value.delivered, true);
    assert.equal(second.value.parts, 3);
    assert.equal(bot.commands.length, 3);
    assert.ok(bot.commands.every(s => s.startsWith('/msg Alice ') && s.length <= 240));
    assert.equal(bot.conversation.pending.size, 0);
});

test('native cancellation route returns controller receipts and retries never cancel the next task', async () => {
    const { routes, bots, spawn } = bridge();
    routes['/start']({ body: { port: 25565 } }, response());
    await spawn();
    const controller = bots[0].tasks;
    const task = controller.enqueue({ task: 'Break the beehive', requester: 'Alice' });
    controller.claim(task.id);
    const body = { operation: 'control', command: 'cancel', sender: 'Alice', target: 'beehive', channel: 'private', key: 'natural-control', expectedRevision: controller.revision };
    const receipt = response();
    await routes['/tasks']({ body }, receipt);
    assert.equal(receipt.value.ok, true);
    assert.equal(task.state, 'cancelled');
    const next = controller.enqueue({ task: 'Break another beehive', requester: 'Alice' });
    controller.claim(next.id);
    const repeated = response();
    await routes['/tasks']({ body }, repeated);
    assert.deepEqual(repeated.value, receipt.value);
    assert.equal(next.state, 'running');
});

test('observation-only startup does not take a movement lease and server pause cannot freeze an active mode', async () => {
    const { routes, bots, spawn } = bridge();
    routes['/start']({ body: { port: 25565, pauseMode: 'tick' } }, response());
    await spawn();
    const bot = bots[0];
    const task = bot.tasks.enqueue({ task: 'Follow Alice', requester: 'Alice' });
    bot.tasks.claim(task.id);
    task.movement = { mode: 'follow' };
    const lease = bot.tasks.beginAction({ id: task.id, generation: task.generation });
    const observed = response();
    await routes['/step']({ body: { code: '', programs: '' } }, observed);
    assert.equal(observed.statusCode, 200);
    assert.equal(bot.tasks.lease, lease);
    const paused = response();
    await routes['/pause']({ body: { mode: 'tick', paused: true } }, paused);
    assert.equal(paused.value.paused, false);
    assert.deepEqual(bot.commands, []);
});
