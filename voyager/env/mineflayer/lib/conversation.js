const { playerState } = require("./playerState");
const { randomUUID } = require("node:crypto");

// One conversation lifetime per Minecraft connection. Diagnostics never go on wire.
class Conversation {
    constructor(bot, now = Date.now) {
        this.bot = bot;
        this.now = now;
        this.session = randomUUID();
        this.sequence = 0;
        this.history = [];
        this.events = [];
        this.pending = new Map();
        this.sent = new Set();
        this.lastSpoke = now();
        this.task = null;
        this.rawChat = bot.chat.bind(bot);
        bot.log = (message) => {
            console.log(`[action] ${message}`);
            bot.emit("chatEvent", bot.username, String(message));
        };
        bot.chat = (message) => {
            if (typeof message !== "string") return;
            if (message.startsWith("/")) return this.rawChat(message);
            bot.log(message); // Also silences old learned skills without rewriting them.
        };
        const event = (type, player) => {
            this.events.push({ type, player, time: new Date(this.now()).toISOString() });
            if (this.events.length > 20) this.events.shift();
        };
        bot.on("playerJoined", player => event("player_joined", player.username));
        bot.on("playerLeft", player => event("player_left", player.username));
        bot.on("death", () => event("agent_died", bot.username));
        let previousHealth;
        bot.on("health", () => {
            if (bot.health <= 6 && previousHealth > 6) event("agent_low_health", bot.username);
            previousHealth = bot.health;
        });
        // Read translation keys for modern vanilla chat, independent of locale.
        // Mineflayer also emits legacy parsed events for the same object.
        const handled = new WeakSet();
        bot.on("message", (message) => {
            const type = message?.translate;
            if (!["chat.type.text", "commands.message.display.incoming"].includes(type) || !message.with?.length) return;
            const sender = message.with[0].toString();
            const text = message.with[1]?.toString();
            if (!/^[A-Za-z0-9_]{1,16}$/.test(sender) || text === undefined) return;
            handled.add(message);
            this.receive(sender, text, type === "chat.type.text" ? "public" : "private");
        });
        bot.on("chat", (sender, text, translate, original) => {
            if (!original || !handled.has(original)) this.receive(sender, text, "public");
        });
        bot.on("whisper", (sender, text, translate, original) => {
            if (!original || !handled.has(original)) this.receive(sender, text, "private");
        });
    }

    players() {
        return Object.keys(this.bot.players || {}).filter(
            (name) => name.toLowerCase() !== this.bot.username?.toLowerCase()
        );
    }

    record(message) {
        const entry = { id: ++this.sequence, time: new Date(this.now()).toISOString(), ...message };
        this.history.push(entry);
        if (this.history.length > 100) this.history.shift();
        return entry;
    }

    receive(sender, text, channel) {
        if (!/^[A-Za-z0-9_]{1,16}$/.test(sender || "") || typeof text !== "string" || sender.toLowerCase() === this.bot.username?.toLowerCase()) return;
        const required = channel === "private" || Boolean(this.bot.username && text.toLowerCase().includes(this.bot.username.toLowerCase()));
        const entry = this.record({ sender, text: text.slice(0, 2000), channel, outgoing: false, required });
        if (required) this.pending.set(entry.id, entry);
    }

    snapshot() {
        return {
            session: this.session, cursor: this.sequence, username: this.bot.username,
            playerLocations: playerState(this.bot),
            inventory: (this.bot.inventory?.items() || []).map(item => ({ name: item.name, count: item.count })),
            players: this.players(), noPlayersOnline: this.players().length === 0,
            events: this.events, history: this.history, pending: [...this.pending.values()],
            task: this.task, lastSpoke: this.lastSpoke,
            state: { health: this.bot.health, food: this.bot.food,
                dimension: this.bot.game?.dimension, position: this.bot.entity?.position, time: this.bot.time?.timeOfDay },
        };
    }

    send({ session, key, replyTo, recipient, text }) {
        if (session !== this.session) throw new Error("Conversation connection changed");
        if (typeof key !== "string" || !key || key.length > 200) throw new Error("Missing delivery key");
        if (this.sent.has(key)) return { delivered: true };
        const original = replyTo == null ? null : this.pending.get(replyTo);
        if (replyTo != null && !original) throw new Error("Message already answered or unknown");
        // Routing comes from the received event, never from the language model.
        const target = original ? (original.channel === "private" ? original.sender : null) : recipient;
        if (target != null && !/^[A-Za-z0-9_]{1,16}$/.test(target)) throw new Error("Invalid recipient");
        if (typeof text !== "string" || !text.trim()) throw new Error("Empty reply");
        const clean = text.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
        if (clean.startsWith("/")) throw new Error("Chat replies cannot execute commands");
        if (!original && !target && this.players().length === 0) return { delivered: false };
        // Keep a reply below Minecraft's command/chat length limit, including /msg.
        const prefix = target ? `/msg ${target} ` : "";
        this.rawChat(prefix + clean.slice(0, 240 - prefix.length));
        this.record({ sender: this.bot.username, text: clean.slice(0, 240 - prefix.length),
            channel: target ? "private" : "public", recipient: target || null, outgoing: true });
        this.lastSpoke = this.now();
        if (original) this.pending.delete(replyTo);
        this.sent.add(key);
        if (this.sent.size > 1000) this.sent.delete(this.sent.values().next().value);
        return { delivered: true };
    }
}
module.exports = { Conversation };
