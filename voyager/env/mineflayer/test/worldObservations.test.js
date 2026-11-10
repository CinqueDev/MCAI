const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Vec3 } = require("vec3");
const { WorldObservations } = require("../lib/worldObservations");

function fixture() {
    const bot = new EventEmitter();
    let now = 10000;
    let blockName = "coal_ore";
    const position = new Vec3(4, 64, 8);
    Object.assign(bot, {
        game: { dimension: "overworld" },
        entity: { position: new Vec3(0, 64, 0) },
        registry: {
            blocksByName: {
                coal_ore: { id: 1 },
                air: { id: 0 },
                chest: { id: 2 },
            },
        },
        findBlocks: () => (blockName === "air" ? [] : [position]),
        blockAt: () => ({ name: blockName }),
        tasks: {
            context: { getStore: () => null },
            active: () => bot.activeTask,
        },
    });
    const observations = new WorldObservations(bot, () => now);
    return {
        bot,
        observations,
        position,
        advance: () => {
            now += 31000;
        },
        setBlock: (name) => {
            blockName = name;
        },
    };
}

test("resource discovery needs no chat and changed blocks invalidate old sightings", () => {
    const { observations, advance, setBlock } = fixture();
    const initial = observations.snapshot();
    assert.equal(initial[0].kind, "resource");
    assert.equal(initial[0].name, "coal_ore");
    assert.equal(initial[0].data.position.x, 4);
    advance();
    setBlock("air");
    assert.ok(
        observations
            .snapshot()
            .some((e) => e.invalidated && e.name === "coal_ore")
    );
});

test("chest inspections preserve their original private task and are never replayed as new inspections", () => {
    const { bot, observations, position, advance } = fixture();
    bot.activeTask = { recipient: "Alice" };
    bot.emit("closeChest", { coal: 5 }, position);
    const first = observations.snapshot().find((e) => e.kind === "storage");
    assert.equal(first.recipient, "Alice");
    assert.equal(first.data.contents.coal, 5);
    bot.activeTask = null;
    advance();
    const repeated = observations.snapshot().find((e) => e.kind === "storage");
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.time, first.time);
});

test("passive rescans do not promote private discoveries after a task ends", () => {
    const { bot, observations, advance } = fixture();
    bot.activeTask = { recipient: "Alice" };
    observations.snapshot();
    bot.activeTask = null;
    advance();
    assert.ok(observations.snapshot().every((e) => e.recipient === "Alice"));
});

test("telemetry history is bounded and records failures with observed position and dimension", () => {
    const { bot, observations } = fixture();
    for (let i = 0; i < 300; i++) bot.emit("error", new Error("path failed"));
    const events = observations.snapshot();
    assert.equal(events.length, 256);
    const failure = events.find((e) => e.kind === "experience");
    assert.equal(failure.dimension, "overworld");
    assert.equal(failure.data.error, "path failed");
});

test("idle experiences keep the last private execution scope until public work starts", () => {
    const { bot, observations } = fixture();
    bot.tasks.observationRecipient = "Alice";
    bot.emit("death");
    assert.equal(observations.events.at(-1).recipient, "Alice");
    bot.activeTask = { recipient: null };
    bot.emit("death");
    assert.equal(observations.events.at(-1).recipient, null);
});
