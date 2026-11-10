const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Conversation } = require("../lib/conversation");

function setup() {
    const bot = new EventEmitter();
    bot.username = "Voyager";
    bot.players = { Voyager: {}, Alice: {}, Bob: {} };
    const wire = [];
    bot.chat = text => wire.push(text);
    const chat = new Conversation(bot, () => 1000);
    return { bot, chat, wire };
}
function reply(chat, extra = {}) {
    return chat.send({ session: chat.session, key: "reply", text: "Hello!", ...extra });
}

test("logs stay internal, commands still work, and player events carry channel and sender", () => {
    const { bot, chat, wire } = setup();
    const diagnostics = [];
    bot.on("chatEvent", (_, text) => diagnostics.push(text));
    bot.chat("Mining coal");
    bot.log("Craft failed");
    bot.chat("/time set day");
    bot.emit("chat", "Alice", "hello everyone");
    bot.emit("chat", "Voyager", "self echo");
    assert.deepEqual(wire, ["/time set day"]);
    assert.deepEqual(diagnostics, ["Mining coal", "Craft failed"]);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0].sender, "Alice");
    assert.equal(chat.history[0].required, false);
    assert.deepEqual(chat.snapshot().players, ["Alice", "Bob"]);
});

test("case insensitive username substrings anywhere require public replies", () => {
    const { bot, chat, wire } = setup();
    bot.emit("chat", "Alice", "hey someVOYAGERthing, come here");
    const [message] = chat.snapshot().pending;
    assert.ok(message.required);
    reply(chat, { replyTo: message.id, recipient: "Bob" });
    assert.deepEqual(wire, ["Hello!"]);
    assert.equal(chat.pending.size, 0);
});

test("private mentions always route to the original sender via /msg", () => {
    const { bot, chat, wire } = setup();
    bot.emit("whisper", "Alice", "Voyager, keep this private");
    const [message] = chat.snapshot().pending;
    reply(chat, { replyTo: message.id, recipient: "Bob" });
    assert.deepEqual(wire, ["/msg Alice Hello!"]);
    assert.equal(chat.history.at(-1).channel, "private");
    assert.equal(chat.history.at(-1).recipient, "Alice");
});

test("modern translated vanilla messages are recorded once despite parsed legacy events", () => {
    const { bot, chat } = setup();
    const message = { translate: "commands.message.display.incoming", with: ["Alice", "hello Voyager"] };
    bot.emit("message", message);
    bot.emit("whisper", "Alice", "hello Voyager", message.translate, message);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0].channel, "private");
    const publicMessage = { translate: "chat.type.text", with: ["Bob", "hey"] };
    bot.emit("message", publicMessage);
    bot.emit("chat", "Bob", "hey", publicMessage.translate, publicMessage);
    assert.equal(chat.history.length, 2);
});

test("delivery retries are idempotent and stale connections cannot speak", () => {
    const { chat, wire } = setup();
    reply(chat);
    reply(chat);
    assert.equal(wire.length, 1);
    assert.throws(() => reply(chat, { session: "old", key: "other" }), /connection changed/);
});

test("reply text cannot become a command, forge lines, or overflow chat", () => {
    const { chat, wire } = setup();
    assert.throws(() => reply(chat, { text: "/op Alice" }), /commands/);
    assert.throws(() => reply(chat, { recipient: "Alice /op Bob" }), /recipient/);
    reply(chat, { recipient: "Alice", text: "Hello\nthere " + "a".repeat(400) });
    assert.ok(wire[0].length <= 240);
    assert.ok(!wire[0].includes("\n"));
    assert.ok(wire[0].startsWith("/msg Alice Hello there"));
});

test("alone is explicit; unsolicited public messages suppressed but required replies survive", () => {
    const { bot, chat, wire } = setup();
    bot.players = { Voyager: {} };
    assert.equal(chat.snapshot().noPlayersOnline, true);
    assert.deepEqual(reply(chat), { delivered: false });
    bot.emit("chat", "Alice", "Voyager?");
    reply(chat, { replyTo: chat.snapshot().pending[0].id });
    assert.deepEqual(wire, ["Hello!"]);
});

test("history is bounded but unacknowledged mandatory messages survive history eviction", () => {
    const { bot, chat } = setup();
    bot.emit("whisper", "Alice", "help");
    for (let i = 0; i < 110; i++) bot.emit("chat", "Bob", "ambient " + i);
    assert.equal(chat.history.length, 100);
    assert.equal(chat.snapshot().pending[0].text, "help");
});
