const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

// Exercise real route handlers without Minecraft, plugins, or a listening socket.
function bridge() {
    const routes = {};
    const bots = [];
    const options = [];
    const app = { use() {}, post(route, handler) { routes[route] = handler; }, listen() {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../index.js"), "utf8"), {
        console, process: { argv: [] },
        require(name) {
            if (name === "express") return () => app;
            if (name === "body-parser") return { json() {}, urlencoded() {} };
            if (name === "./lib/conversation") return require("../lib/conversation");
            if (name === "./lib/connection") return require("../lib/connection");
            if (name === "./lib/pause") return require("../lib/pause");
            if (name === "mineflayer") return { createBot(settings) {
                options.push(settings);
                const bot = new EventEmitter();
                bot.end = () => bot.emit("end", "closed");
                bot.chat = (command) => {
                    bot.commands.push(command);
                    queueMicrotask(() => bot.emit("message", { json: { translate:
                        command === "/tick freeze" ? "commands.tick.status.frozen" : "commands.tick.status.running",
                    } }));
                };
                bot.commands = [];
                bots.push(bot);
                return bot;
            } };
            return {};
        },
    });
    return { routes, bots, options };
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
    const { routes, bots } = bridge();
    const body = { port: 25565, pauseMode: "tick" };
    routes["/start"]({ body }, response());
    routes["/start"]({ body }, response());
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

test("chat routes operate independently and enforce the incoming private channel", () => {
    const { routes, bots } = bridge();
    routes["/start"]({ body: { port: 25565 } }, response());
    const bot = bots[0];
    bot.username = "Voyager";
    bot.players = { Alice: {}, Voyager: {} };
    bot.emit("whisper", "Alice", "Voyager hello");
    const inbox = response();
    routes["/chat"]({ body: {} }, inbox);
    const { session, pending } = inbox.value;
    const out = response();
    routes["/chat"]({ body: { session, replyTo: pending[0].id, key: "1", recipient: "Bob", text: "Hello" } }, out);
    assert.equal(out.value.delivered, true);
    assert.deepEqual(bot.commands, ["/msg Alice Hello"]);
    routes["/chat"]({ body: { session, replyTo: pending[0].id, key: "1", text: "Hello" } }, response());
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
