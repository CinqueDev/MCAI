const { Vec3 } = require("vec3");
const { randomUUID } = require("node:crypto");

// This telemetry never goes straight into public conversation prompts. Python stores
// it under the original task's visibility and retrieves only authorized records.
class WorldObservations {
    constructor(bot, now = Date.now) {
        this.bot = bot;
        this.now = now;
        this.session = randomUUID();
        this.sequence = 0;
        this.events = [];
        this.tracked = new Map();
        this.lastScan = -Infinity;
        bot.on("closeChest", (contents, position) => {
            this.record({
                kind: "storage",
                key: this.blockKey("container", position),
                name: "Chest",
                data: {
                    position: this.position(position),
                    contents,
                    inspected: true,
                },
            });
        });
        bot.on("removeChest", (position) => {
            this.record({
                kind: "storage",
                key: this.blockKey("container", position),
                name: "Removed chest",
                invalidated: true,
            });
        });
        let previousHealth;
        bot.on("health", () => {
            if (previousHealth > 6 && bot.health <= 6)
                this.record({
                    kind: "experience",
                    name: "Agent reached low health here",
                    data: {
                        position: this.position(bot.entity?.position),
                        health: bot.health,
                        cause: "unknown",
                    },
                });
            previousHealth = bot.health;
        });
        bot.on("death", () =>
            this.record({
                kind: "experience",
                name: "Agent died here",
                data: {
                    position: this.position(bot.entity?.position),
                    outcome: "death",
                },
            })
        );
        bot.on("error", (error) =>
            this.record({
                kind: "experience",
                name: "An action or connection failed",
                data: {
                    position: this.position(bot.entity?.position),
                    error: String(error?.message || error).slice(0, 1000),
                },
            })
        );
    }

    position(value) {
        return value ? { x: value.x, y: value.y, z: value.z } : null;
    }
    blockKey(prefix, value) {
        return `${prefix}:${JSON.stringify(this.position(value))}`;
    }
    visibility() {
        const lease = this.bot.tasks?.context.getStore();
        const task = lease?.taskId
            ? this.bot.tasks.get(lease.taskId)
            : this.bot.tasks?.active();
        return task
            ? task.recipient || null
            : this.bot.tasks?.observationRecipient || null;
    }
    record(event) {
        this.events.push({
            id: `${this.session}:${++this.sequence}`,
            time: this.now() / 1000,
            recipient: this.visibility(),
            dimension: this.bot.game?.dimension || null,
            ...event,
        });
        if (this.events.length > 256) this.events.shift();
    }
    scan() {
        const bot = this.bot;
        if (
            this.now() - this.lastScan < 5000 ||
            !bot.findBlocks ||
            !bot.blockAt ||
            !bot.entity?.position ||
            !bot.registry?.blocksByName
        )
            return;
        this.lastScan = this.now();
        const names = Object.keys(bot.registry.blocksByName).filter((name) =>
            /(?:_ore$|^ancient_debris$|^water$|^lava$|^wheat$|^carrots$|^potatoes$|^farmland$|^bell$|^crafting_table$|^furnace$|^chest$|_bed$)/.test(
                name
            )
        );
        const identifiers = names.map(
            (name) => bot.registry.blocksByName[name].id
        );
        const locations =
            bot.findBlocks({
                matching: identifiers,
                maxDistance: 24,
                count: 32,
            }) || [];
        const inspect = (value) => {
            value = new Vec3(value.x, value.y, value.z);
            const block = bot.blockAt(value);
            if (!block) return;
            const key = this.blockKey("block", value);
            const previous = this.tracked.get(key);
            if (previous && previous.name !== block.name) {
                this.record({
                    kind: previous.kind,
                    key,
                    name: previous.name,
                    invalidated: true,
                    recipient: previous.recipient,
                    data: {
                        position: this.position(value),
                        replacement: block.name,
                    },
                });
                if (previous.name === "chest")
                    this.record({
                        kind: "storage",
                        key: this.blockKey("container", value),
                        name: "Removed chest",
                        recipient: previous.recipient,
                        invalidated: true,
                    });
                this.tracked.delete(key);
            }
            if (!names.includes(block.name)) return;
            if (
                previous?.name === block.name &&
                this.now() - previous.verified < 30000
            )
                return;
            const kind =
                /_ore$|ancient_debris|water|wheat|carrots|potatoes|farmland/.test(
                    block.name
                )
                    ? "resource"
                    : block.name === "lava"
                    ? "experience"
                    : "place";
            // Passive scans do not publish locations originally learned in private work.
            const recipient = previous?.recipient || this.visibility();
            this.record({
                kind,
                key,
                type: "block_observed",
                name: block.name,
                recipient,
                data: {
                    position: this.position(value),
                    block: block.name,
                    hazard: block.name === "lava",
                },
            });
            this.tracked.set(key, {
                name: block.name,
                kind,
                recipient,
                verified: this.now(),
                position: this.position(value),
            });
        };
        for (const location of locations) inspect(location);
        for (const entry of [...this.tracked.values()]) {
            const p = entry.position;
            if (
                bot.entity.position.distanceTo({ x: p.x, y: p.y, z: p.z }) <= 24
            )
                inspect(p);
        }
        while (this.tracked.size > 512)
            this.tracked.delete(this.tracked.keys().next().value);
    }
    snapshot() {
        this.scan();
        return this.events.slice();
    }
}
module.exports = { WorldObservations };
