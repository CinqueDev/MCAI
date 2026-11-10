const { renderCommandHelp } = require("./commandCatalog");
const { ChatDelivery } = require("./chatDelivery");
const { parseLocationMemory } = require("./locationMemory");
const { parseControl } = require("./tasks");
const { playerState } = require("./playerState");
const { randomUUID } = require("node:crypto");

// One conversation lifetime per Minecraft connection. Diagnostics never go on wire.
class Conversation {
    constructor(bot, now = Date.now, deliveryOptions = {}) {
        this.bot = bot;
        this.now = now;
        this.session = randomUUID();
        this.sequence = 0;
        this.history = [];
        this.events = [];
        this.pending = new Map();
        this.delivery = new ChatDelivery(this, deliveryOptions);
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
            this.events.push({
                type,
                player,
                time: new Date(this.now()).toISOString(),
            });
            if (this.events.length > 20) this.events.shift();
        };
        bot.on("playerJoined", (player) =>
            event("player_joined", player.username)
        );
        bot.on("playerLeft", (player) => event("player_left", player.username));
        bot.on("death", () => event("agent_died", bot.username));
        let previousHealth;
        bot.on("health", () => {
            if (bot.health <= 6 && previousHealth > 6)
                event("agent_low_health", bot.username);
            previousHealth = bot.health;
        });
        // Read translation keys for modern vanilla chat, independent of locale.
        // Mineflayer also emits legacy parsed events for the same object.
        const handled = new WeakSet();
        bot.on("message", (message) => {
            const type = message?.translate;
            if (
                ![
                    "chat.type.text",
                    "commands.message.display.incoming",
                ].includes(type) ||
                !message.with?.length
            )
                return;
            const sender = message.with[0].toString();
            const text = message.with[1]?.toString();
            if (!/^[A-Za-z0-9_]{1,16}$/.test(sender) || text === undefined)
                return;
            handled.add(message);
            this.receive(
                sender,
                text,
                type === "chat.type.text" ? "public" : "private"
            );
        });
        bot.on("chat", (sender, text, translate, original) => {
            if (!original || !handled.has(original))
                this.receive(sender, text, "public");
        });
        bot.on("whisper", (sender, text, translate, original) => {
            if (!original || !handled.has(original))
                this.receive(sender, text, "private");
        });
    }

    players() {
        return playerState(this.bot).map(player => player.username);
    }

    record(message) {
        const entry = {
            id: ++this.sequence,
            time: new Date(this.now()).toISOString(),
            ...message,
        };
        this.history.push(entry);
        if (this.history.length > 100) this.history.shift();
        return entry;
    }

    receive(sender, text, channel) {
        if (
            !/^[A-Za-z0-9_]{1,16}$/.test(sender || "") ||
            typeof text !== "string" ||
            sender.toLowerCase() === this.bot.username?.toLowerCase()
        )
            return;
        const locationMemory = parseLocationMemory(text, this.bot.username);
        const required =
            Boolean(locationMemory) || channel === "private" ||
            Boolean(
                this.bot.username &&
                    text.toLowerCase().includes(this.bot.username.toLowerCase())
            );
        const entry = this.record({
            sender,
            text: text.slice(0, 2000),
            channel,
            outgoing: false,
            required,
            locationMemory,
        });
        const player = playerState(this.bot).find(
            (p) => p.username.toLowerCase() === sender.toLowerCase()
        );
        entry.requesterLocation = player?.position || null;
        entry.requesterDimension = player?.position
            ? this.bot.game?.dimension || null
            : null;
        if (required) this.pending.set(entry.id, entry);
        this.handleControl(entry);
    }

    handleControl(entry) {
        if (entry.control || entry.outgoing) return;
        const { sender, text, channel } = entry;
        const control = parseControl(text, this.bot.username);
        if (control && (control.command === "cmds" || this.bot.tasks)) {
            entry.required = true;
            this.pending.set(entry.id, entry);
            entry.control = true;
            const response = control.command === "cmds"
                ? Promise.resolve(renderCommandHelp(this.bot.username))
                : this.bot.tasks.control(control.command, sender, control.id, channel);
            response.catch((error) => {
                    console.error("Task control failed", error);
                    return "I couldn't finish that task control. Please try again.";
                })
                .then((reply) => this.send({
                    session: this.session,
                    key: `control:${entry.id}`,
                    replyTo: entry.id,
                    text: reply,
                }))
                .catch(error => console.error("Could not deliver task control reply:", error.message));
        }
    }

    snapshot() {
        return {
            session: this.session,
            cursor: this.sequence,
            username: this.bot.username,
            worldObservations: this.bot.worldObservations?.snapshot() || [],
            playerLocations: playerState(this.bot),
            inventory: (this.bot.inventory?.items() || []).map((item) => ({
                name: item.name,
                count: item.count,
            })),
            players: this.players(),
            noPlayersOnline: this.players().length === 0,
            events: this.events,
            history: this.history,
            pending: [...this.pending.values()].filter((m) => !m.control),
            taskControl: this.bot.tasks?.snapshot(),
            task: this.task,
            lastSpoke: this.lastSpoke,
            state: {
                health: this.bot.health,
                food: this.bot.food,
                dimension: this.bot.game?.dimension,
                position: this.bot.entity?.position,
                time: this.bot.time?.timeOfDay,
            },
        };
    }

    send({ session, key, replyTo, recipient, text }) {
        if (session !== this.session)
            throw new Error("Conversation connection changed");
        if (typeof key !== "string" || !key || key.length > 200)
            throw new Error("Missing delivery key");
        const existing = this.delivery.existing(key);
        if (existing) return existing;
        const original = replyTo == null ? null : this.pending.get(replyTo);
        if (replyTo != null && !original)
            throw new Error("Message already answered or unknown");
        // Routing comes from the received event, never from the language model.
        const target = original
            ? original.channel === "private"
                ? original.sender
                : null
            : recipient;
        if (target != null && !/^[A-Za-z0-9_]{1,16}$/.test(target))
            throw new Error("Invalid recipient");
        if (typeof text !== "string" || !text.trim())
            throw new Error("Empty reply");
        const clean = text.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
        if (clean.startsWith("/"))
            throw new Error("Chat replies cannot execute commands");
        if (!original && !target && this.players().length === 0)
            return { delivered: false };
        const prefix = target ? `/msg ${target} ` : "";
        const maximum = this.bot.supportFeature?.("lessCharsInChat") ? 100 : 240;
        return this.delivery.enqueue(key, { clean, prefix, target, original, maximum });
    }
}
module.exports = { Conversation };
