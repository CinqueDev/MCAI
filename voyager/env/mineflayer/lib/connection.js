const fs = require("node:fs");
const path = require("node:path");

function connectionOptions(body) {
    const auth = body.auth ?? "offline";
    if (!["offline", "microsoft"].includes(auth)) {
        throw new Error("auth must be offline or microsoft");
    }
    const username = body.username ?? (auth === "offline" ? "bot" : "");
    if (typeof username !== "string" || !username.trim()) {
        throw new Error("A username/account identifier is required");
    }
    if (auth === "offline" && !/^[A-Za-z0-9_]{1,16}$/.test(username)) {
        throw new Error("Offline username must contain 1-16 letters, digits, or underscores");
    }
    const host = body.host ?? "localhost";
    if (typeof host !== "string" || !host.trim()) throw new Error("Invalid Minecraft host");
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
        throw new Error("Invalid Minecraft port");
    }
    const options = {
        host, port: body.port, username, auth,
        disableChatSigning: auth === "offline",
        checkTimeoutInterval: 60 * 60 * 1000,
    };
    if (body.version) options.version = body.version;
    if (auth === "microsoft") {
        options.profilesFolder = path.resolve(body.profilesFolder || ".minecraft-auth");
        fs.mkdirSync(options.profilesFolder, { recursive: true, mode: 0o700 });
        options.onMsaCode = (data) => {
            const message = data.message || `Open ${data.verification_uri} and enter ${data.user_code}`;
            console.log(`Microsoft sign-in: ${message.replace(/\s+/g, " ")}`);
        };
    }
    return options;
}

// A kick or socket closure before spawn must finish /start, too.
function watchConnection(bot, onFailure, onEnd) {
    let ready = false;
    let failed = false;
    let ended = false;
    const cleanup = () => {
        if (ended) return;
        ended = true;
        onEnd();
    };
    const fail = (reason) => {
        if (ready || failed) return;
        failed = true;
        onFailure(reason instanceof Error ? reason.message :
            typeof reason === "string" ? reason : JSON.stringify(reason));
    };
    bot.on("error", (error) => {
        fail(error);
        if (ready) console.error("Minecraft connection error:", error.message);
    });
    bot.once("kicked", (reason) => {
        fail(reason);
        bot.end();
        cleanup();
    });
    bot.once("end", (reason) => {
        fail(reason || "Disconnected before spawning");
        cleanup();
    });
    return { ready() { ready = true; } };
}

module.exports = { connectionOptions, watchConnection };
