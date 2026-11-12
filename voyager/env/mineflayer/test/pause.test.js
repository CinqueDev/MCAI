const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { tickPause, setPaused } = require("../lib/pause");

function fakeBot() {
    const bot = new EventEmitter();
    bot.commands = [];
    bot.waitForTicks = () => { throw new Error("Must not wait for frozen ticks"); };
    bot.chat = (command) => {
        bot.commands.push(command);
        queueMicrotask(() => bot.emit("message", { json: {
            translate: command === "/tick freeze" ? "commands.tick.status.frozen" : "commands.tick.status.running",
        } }));
    };
    return bot;
}

test("tick mode freezes and explicitly unfreezes without waiting for ticks", async () => {
    const bot = fakeBot();
    await setPaused(bot, "tick", true);
    await setPaused(bot, "tick", false);
    assert.deepEqual(bot.commands, ["/tick freeze", "/tick unfreeze"]);
    assert.equal(bot.listenerCount("message"), 0);
    assert.equal(bot.listenerCount("end"), 0);
});

test("lack of OP reports rejection and attempts to unfreeze", async () => {
    const bot = fakeBot();
    bot.chat = (command) => {
        bot.commands.push(command);
        queueMicrotask(() => bot.emit("message", {
            json: { translate: "commands.generic.permission" }, toString: () => "No permission",
        }));
    };
    await assert.rejects(setPaused(bot, "tick", true), /No permission/);
    assert.deepEqual(bot.commands, ["/tick freeze", "/tick unfreeze"]);
    assert.equal(bot.listenerCount("message"), 0);
});

test("missing command feedback times out with useful reason", async () => {
    const bot = fakeBot();
    bot.chat = () => {};
    await assert.rejects(tickPause(bot, true, 10), /sendCommandFeedback/);
    assert.equal(bot.listenerCount("message"), 0);
});

test("disconnect rejects pending pause", async () => {
    const bot = fakeBot();
    bot.chat = () => queueMicrotask(() => bot.emit("end"));
    await assert.rejects(tickPause(bot, true), /Disconnected/);
    assert.equal(bot.listenerCount("message"), 0);
});

test("none sends no commands and mod retains legacy toggle", async () => {
    const bot = fakeBot();
    await setPaused(bot, "none", true);
    assert.deepEqual(bot.commands, []);
    bot.waitForTicks = async () => {};
    await setPaused(bot, "mod", true);
    assert.deepEqual(bot.commands, ["/pause"]);
});

test("world protection disables tick and mod pausing even when called directly", async () => {
    const bot = fakeBot();
    bot.allowWorldChanges = false;
    for (const mode of ["tick", "mod"]) {
        await setPaused(bot, mode, true);
        await setPaused(bot, mode, false);
    }
    assert.deepEqual(bot.commands, []);
});
