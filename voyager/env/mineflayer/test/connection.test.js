const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connectionOptions, watchConnection } = require("../lib/connection");

test("legacy LAN and explicit remote offline options", () => {
    const local = connectionOptions({ port: 12345 });
    assert.equal(local.host, "localhost");
    assert.equal(local.username, "bot");
    assert.equal(local.auth, "offline");
    assert.equal(local.disableChatSigning, true);
    const remote = connectionOptions({ host: "example.org", port: 25565,
        username: "Voyager", auth: "offline", version: "1.19" });
    assert.equal(remote.host, "example.org");
    assert.equal(remote.version, "1.19");
    assert.equal(remote.username, "Voyager");
    assert.equal(remote.profilesFolder, undefined);
});

test("Microsoft options enable signing and expose device prompt without tokens", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voyager-auth-"));
    const original = console.log;
    const messages = [];
    try {
        const options = connectionOptions({ port: 25565, auth: "microsoft",
            username: "account@example.org", profilesFolder: path.join(dir, "cache") });
        assert.equal(options.disableChatSigning, false);
        assert.equal(options.auth, "microsoft");
        assert.ok(fs.statSync(options.profilesFolder).isDirectory());
        console.log = (message) => messages.push(message);
        options.onMsaCode({ message: "Open login page and enter CODE", access_token: "SECRET" });
        assert.deepEqual(messages, ["Microsoft sign-in: Open login page and enter CODE"]);
    } finally {
        console.log = original;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("invalid login settings fail before connecting", () => {
    for (const body of [{ port: 0 }, { port: 65536 }, { port: "25565" },
        { port: 25565, auth: "unknown" }, { port: 25565, auth: "microsoft" },
        { port: 25565, username: "bad name" }, { port: 25565, host: "" }]) {
        assert.throws(() => connectionOptions(body));
    }
});

for (const event of ["error", "kicked", "end"]) {
    test(`${event} before readiness reports failure once and cleans up`, () => {
        const bot = new EventEmitter();
        bot.end = () => bot.emit("end", "closed");
        const failures = [];
        let ended = false;
        watchConnection(bot, (reason) => failures.push(reason), () => { ended = true; });
        bot.emit("spawn"); // Startup can still fail while observations initialize.
        bot.emit(event, event === "error" ? new Error("login failed") : "login failed");
        bot.emit("end", "closed");
        assert.deepEqual(failures, ["login failed"]);
        assert.equal(ended, true);
    });
}

test("disconnect after ready does not send a second start response", () => {
    const bot = new EventEmitter();
    const failures = [];
    let ended = false;
    const connection = watchConnection(bot, (reason) => failures.push(reason), () => { ended = true; });
    connection.ready();
    bot.emit("end", "closed");
    assert.deepEqual(failures, []);
    assert.equal(ended, true);
});
