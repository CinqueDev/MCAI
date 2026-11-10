const { MovementModes } = require("./movementModes");
const { resolveWorldTarget } = require("./targetResolver");
const { CONTROLS, renderCommandHelp } = require("./commandCatalog");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

class TaskInterrupted extends Error {
    constructor(message = "Task was stopped or paused") {
        super(message);
        this.name = "TaskInterrupted";
    }
}

class TaskController {
    constructor(bot, { journalPath = null, operators = [] } = {}) {
        this.bot = bot;
        this.path = journalPath;
        this.operators = operators.map((name) => name.toLowerCase());
        this.context = new AsyncLocalStorage();
        this.atomicContext = new AsyncLocalStorage();
        this.lease = null;
        this.planning = false;
        this.cleanupCount = 0;
        this.revision = 0;
        this.records = [];
        this.controlReceipts = Object.create(null);
        this.controlInFlight = new Map();
        this.disconnected = false;
        this.suspended = false;
        this.suspendOwner = null;
        this.suspensionReason = null;
        this.observationRecipient = null;
        if (this.path && fs.existsSync(this.path)) {
            const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
            if (data.version !== 1 || !Array.isArray(data.tasks))
                throw new Error("Unsupported task journal");
            this.records = data.tasks;
            this.controlReceipts = Object.assign(Object.create(null), data.controlReceipts || {});
            this.suspensionReason = data.suspensionReason || null;
            this.revision = (data.revision || 0) + 1;
            this.suspended = Boolean(data.suspended);
            this.suspendOwner = data.suspendOwner || null;
            this.observationRecipient = data.observationRecipient || null;
            const legacyRecovery = !data.suspensionReason && !this.suspendOwner &&
                this.records.some(t => t.state === "paused" && t.recovery && !t.needsReview);
            if (legacyRecovery) this.suspended = false;
            const explicitHalt = this.suspended;
            for (const task of this.records) {
                if (task.state === "running" || (legacyRecovery && task.state === "paused" && task.recovery && !task.needsReview)) {
                    task.generation++;
                    task.recovery = true;
                    task.needsReview = Boolean(task.needsReview || task.actions.some(a => a.operations?.some(o =>
                        ["started", "uncertain"].includes(o.state) && (o.irreversible || ["craft", "consume"].includes(o.name)))));
                    task.state = task.needsReview || explicitHalt ? "paused" : "queued";
                    for (const action of task.actions) if (action.state === "started") action.state = "interrupted";
                    if (task.needsReview) {
                        this.suspended = true;
                        this.suspensionReason = "review";
                        this.suspendOwner ||= task.requester;
                    }
                }
            }
        }
        bot.once?.("end", () => {
            this.disconnected = true;
            this.lease?.abort.abort();
        });
        this.movementModes = new MovementModes(this);
        this.save();
    }

    save() {
        if (!this.path || this.disconnected) return;
        fs.mkdirSync(path.dirname(this.path), { recursive: true });
        const temporary = this.path + ".tmp";
        fs.writeFileSync(
            temporary,
            JSON.stringify(
                {
                    version: 1,
                    revision: this.revision,
                    suspended: this.suspended,
                    suspendOwner: this.suspendOwner,
                    suspensionReason: this.suspensionReason,
                    controlReceipts: this.controlReceipts,
                    observationRecipient: this.observationRecipient,
                    tasks: this.records,
                },
                null,
                2
            ),
            { mode: 0o600 }
        );
        fs.renameSync(temporary, this.path);
    }

    get(id) {
        return this.records.find((t) => t.id === id);
    }
    active() {
        return this.records.find((t) =>
            ["running", "paused"].includes(t.state)
        );
    }
    snapshot() {
        this.movementModes.dispatch();
        return {
            revision: this.revision,
            busy: Boolean(this.lease || this.cleanupCount),
            planning: this.planning,
            suspended: this.suspended,
            active: this.active() || null,
            tasks: this.records,
        };
    }
    enqueue({
        task,
        requester = null,
        recipient = null,
        context = "",
        priority = 100,
        key = null,
        expectedRevision = null,
    }) {
        if (expectedRevision !== null && expectedRevision !== this.revision)
            return null;
        if (typeof task !== "string" || !task.trim())
            throw new Error("Task description is required");
        if (requester !== null && !/^[A-Za-z0-9_]{1,16}$/.test(requester))
            throw new Error("Invalid requester");
        if (recipient !== null && recipient !== requester)
            throw new Error("Private tasks must belong to their recipient");
        if (key) {
            const existing = this.records.find((t) => t.key === key);
            if (existing) return existing;
        }
        const duplicate = this.records.find(
            (t) =>
                ["queued", "running", "paused"].includes(t.state) &&
                t.task === task &&
                t.requester === requester &&
                t.recipient === recipient
        );
        if (duplicate) return duplicate;
        if (this.records.filter((t) => t.state === "queued").length >= 20)
            throw new Error("Task queue is full");
        const record = {
            id: randomUUID(),
            key,
            task: task.slice(0, 2000),
            requester,
            recipient,
            context,
            priority,
            state: "queued",
            generation: 0,
            actions: [],
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        };
        this.records.push(record);
        this.save();
        this.movementModes.yieldForForeground(record);
        return record;
    }

    claim(id = null) {
        if (this.suspended || this.active() || this.lease || this.cleanupCount) return null;
        const record = id
            ? this.get(id)
            : this.records
                  .filter((t) => t.state === "queued")
                  .sort((a, b) => b.priority - a.priority)[0];
        if (!record || record.state !== "queued") return null;
        record.state = "running";
        this.revision++;
        this.planning = false;
        record.generation++;
        record.updated = new Date().toISOString();
        this.save();
        return record;
    }

    complete(id, generation, success, reason = "") {
        const record = this.get(id);
        if (
            !record ||
            record.state !== "running" ||
            record.generation !== generation
        )
            return false;
        record.state = success ? "completed" : "failed";
        this.revision++;
        record.reason = reason;
        record.updated = new Date().toISOString();
        this.save();
        return true;
    }

    yieldTask(id, generation) {
        const record = this.get(id);
        if (
            !record ||
            record.state !== "running" ||
            record.generation !== generation
        )
            return false;
        record.state = "queued";
        record.generation++;
        this.save();
        return true;
    }

    owns(record, sender) {
        return (
            !record.requester ||
            record.requester.toLowerCase() === sender.toLowerCase() ||
            this.operators.includes(sender.toLowerCase())
        );
    }

    async executeControl(request) {
        const { command, sender, id = null, target = null, channel = "public", expectedRevision = null, key = null } = request;
        if (!["stop", "cancel", "pause", "resume", "status", "queue"].includes(command) ||
            !/^[A-Za-z0-9_]{1,16}$/.test(sender || "") ||
            (id !== null && typeof id !== "string") || (target !== null && (typeof target !== "string" || !target.trim() || target.length > 120)) ||
            !["private", "public"].includes(channel) || (key !== null && (typeof key !== "string" || key.length > 250)))
            throw new Error("Invalid task control request");
        const signature = JSON.stringify({ command, sender, id, target, channel });
        if (key && this.controlReceipts[key]) {
            if (this.controlReceipts[key].signature !== signature) throw new Error("Control key reused for a different request");
            return this.controlReceipts[key].result;
        }
        if (key && this.controlInFlight.has(key)) {
            const existing = this.controlInFlight.get(key);
            if (existing.signature !== signature) throw new Error("Control key reused for a different request");
            return existing.promise;
        }
        const run = async () => {
            const before = this.revision;
            const message = expectedRevision !== null && expectedRevision !== this.revision
                ? "Work changed while I was thinking. Please repeat the control request."
                : await this.control(command, sender, id, channel, target);
            const result = { ok: this.revision !== before || ["status", "queue"].includes(command), message, revision: this.revision };
            if (key) {
                this.controlReceipts[key] = { signature, result };
                const keys = Object.keys(this.controlReceipts);
                for (const old of keys.slice(0, Math.max(0, keys.length - 1000))) delete this.controlReceipts[old];
                this.save();
            }
            return result;
        };
        const promise = run();
        if (key) this.controlInFlight.set(key, { signature, promise });
        try { return await promise; }
        finally { if (key) this.controlInFlight.delete(key); }
    }

    async control(command, sender, id = null, channel = "public", target = null) {
        if (command === "cmds") return renderCommandHelp(this.bot.username);
        let record;
        if (target) {
            const words = target.toLowerCase().match(/[a-z0-9_]+/g) || [];
            const matches = this.records.filter(t =>
                ["queued", "running", "paused"].includes(t.state) && this.owns(t, sender) &&
                (!t.recipient || (channel === "private" && t.requester?.toLowerCase() === sender.toLowerCase())) &&
                words.length && words.every(word => t.task.toLowerCase().includes(word)));
            if (!matches.length) return "No active or queued task matches that name in this chat. Use queue to see task IDs.";
            if (matches.length > 1) return "More than one task matches. Use " + command + " task <id>: " +
                matches.map(t => `${t.id.slice(0, 8)}: ${t.task}`).join("; ");
            record = matches[0];
        } else if (id) {
            const matches = this.records.filter((t) => t.id.startsWith(id));
            if (matches.length !== 1)
                return "That task ID is unknown or ambiguous.";
            record = matches[0];
        } else record = this.active();
        if (command === "status" || command === "queue") {
            const visible = this.records.filter(
                (t) =>
                    (!t.recipient ||
                        (channel === "private" &&
                            t.requester?.toLowerCase() ===
                                sender.toLowerCase())) &&
                    (command === "queue"
                        ? ["queued", "paused", "running"].includes(t.state)
                        : t.id === record?.id)
            );
            if (
                !visible.length &&
                record?.recipient &&
                command === "status" &&
                channel === "public"
            )
                return this.suspended
                    ? "A private task is paused. Ask privately for status and recovery instructions."
                    : "A private task is active. Ask privately for its status.";
            const halt = this.suspended
                ? "Work is paused; resume is needed before queued work can run. "
                : "";
            if (
                !visible.length &&
                command === "status" &&
                this.planning &&
                !this.suspended
            )
                return "Planning the next task; player requests can run while I think.";
            if (
                !visible.length &&
                command === "status" &&
                this.lease &&
                !this.suspended
            )
                return "Finishing the previous action before dispatching the next task.";
            return (
                halt +
                (visible.length
                    ? visible
                          .map(
                              (t) =>
                                  `${t.id.slice(0, 8)}: ${t.state} — ${
                                      t.task
                                  } (${
                                      t.actions.filter(
                                          (a) => a.state === "completed"
                                      ).length
                                  } action batches)`
                          )
                          .join("; ")
                    : this.suspended
                    ? "Work is stopped. Say resume to continue."
                    : "No active tasks.")
            );
        }
        if (
            command === "resume" &&
            this.suspendOwner &&
            this.suspendOwner.toLowerCase() !== sender.toLowerCase() &&
            !this.operators.includes(sender.toLowerCase())
        )
            return "Only the player who paused or stopped work or a configured task operator can resume it.";
        if (
            !record &&
            this.suspendOwner &&
            this.suspendOwner.toLowerCase() !== sender.toLowerCase() &&
            !this.operators.includes(sender.toLowerCase())
        )
            return "Only the player who stopped work or a configured task operator can resume it.";
        if (record && !this.owns(record, sender))
            return "Only this task's requester or a configured task operator can control it.";
        if (
            record?.recipient &&
            record.requester.toLowerCase() !== sender.toLowerCase() &&
            command !== "stop"
        ) {
            return "Control that private task by its requester, or use stop to halt work.";
        }
        if (
            ["pause", "stop", "resume"].includes(command) &&
            record &&
            record.id !== this.active()?.id &&
            this.active()
        )
            return "Select the active task for that control; use cancel to remove a queued task.";
        if (["pause", "stop"].includes(command) && record?.state === "queued")
            return "Use cancel to remove a queued task, or pause the active task.";
        if (["pause", "stop"].includes(command)) {
            this.revision++;
            this.suspended = true;
            this.suspendOwner = sender;
            this.suspensionReason = "manual";
            if (record && ["running", "paused"].includes(record.state)) {
                record.state = command === "pause" ? "paused" : "cancelled";
                record.generation++;
            }
            this.save(); // Invalidate the lease before waiting for cleanup.
            await this.interrupt();
            return command === "pause"
                ? "Paused. Completed work is kept; say resume to continue."
                : "Stopped. Completed work is kept; say resume when you want me to work again.";
        }
        if (command === "cancel") {
            if (
                !record ||
                !["running", "paused", "queued"].includes(record.state)
            )
                return "There is no matching task to cancel.";
            this.revision++;
            record.state = "cancelled";
            record.generation++;
            this.save();
            if (this.lease?.taskId === record.id) await this.interrupt();
            return `Cancelled ${record.id.slice(
                0,
                8
            )}. Completed work is kept.${
                this.suspended
                    ? " Work remains paused; say resume to run queued work."
                    : ""
            }`;
        }
        if (command === "resume") {
            if (record?.needsReview)
                return "An interrupted item operation needs inventory review. Cancel that task and request only the remaining work; I won't replay the uncertain transfer.";
            this.revision++;
            this.suspended = false;
            this.suspendOwner = null;
            this.suspensionReason = null;
            if (record?.state === "paused") {
                record.state = "running";
                record.generation++;
            }
            this.save();
            return "Resumed. I'll recheck progress before continuing.";
        }
        return "Unknown task control.";
    }

    beginAction(execution) {
        if (this.lease || this.cleanupCount)
            throw new TaskInterrupted("An earlier action is still finishing");
        if (!execution) {
            if (this.suspended || this.active()) throw new TaskInterrupted();
            execution = { id: null, generation: 0 };
        }
        const record = execution.id ? this.get(execution.id) : null;
        if (
            execution.id &&
            (!record ||
                record.state !== "running" ||
                record.needsReview ||
                record.generation !== execution.generation)
        )
            throw new TaskInterrupted();
        if (this.suspended) throw new TaskInterrupted();
        if (record) this.observationRecipient = record.recipient || null;
        const action = {
            id: randomUUID(),
            state: "started",
            started: new Date().toISOString(),
            dimension: this.bot.game?.dimension || null,
            operations: [],
            results: [],
        };
        const lease = {
            taskId: execution.id,
            generation: execution.generation,
            action,
            abort: new AbortController(),
            finished: false,
            pending: new Set(),
            atomicLock: false,
        };
        this.lease = lease;
        if (record) record.actions.push(action);
        this.save();
        return lease;
    }

    check() {
        const lease = this.context.getStore();
        if (!lease) return; // Startup and observation work have no generated-action context.
        const record = lease.taskId ? this.get(lease.taskId) : null;
        if (
            this.disconnected || lease.finished ||
            lease.closing ||
            lease.abort.signal.aborted ||
            this.suspended ||
            (record &&
                (record.state !== "running" ||
                    record.generation !== lease.generation))
        )
            throw new TaskInterrupted();
    }

    async operation(name, fn, irreversible = false) {
        const lease = this.context.getStore();
        const nested = lease && this.atomicContext.getStore() === lease;
        if (!nested) this.check();
        if (!lease) return fn();
        const atomic =
            irreversible ||
            [
                "placeBlock",
                "dig",
                "craft",
                "equip",
                "consume",
                "activateBlock",
                "useOn",
                "openContainer",
                "openFurnace",
            ].includes(name);
        if (atomic && !nested && lease.atomicLock)
            throw new Error("Run inventory and world mutations sequentially");
        const operation = { name, irreversible, atomic, state: "started" };
        if (irreversible)
            operation.inventoryBefore = this.bot.inventory
                ?.items()
                .map((i) => ({ name: i.name, count: i.count }));
        lease.action.operations.push(operation);
        this.save();
        if (atomic && !nested) lease.atomicLock = true;
        let result, pending;
        try {
            if (atomic) {
                pending = Promise.resolve(this.atomicContext.run(lease, fn));
                lease.pending.add(pending);
                result = await pending;
            } else result = await this.abortable(fn(), lease);
            operation.state = "completed";
        } catch (error) {
            operation.state = irreversible ? "uncertain" : "interrupted";
            const record = lease.taskId && this.get(lease.taskId);
            if (irreversible && record) {
                this.revision++;
                record.needsReview = true;
                record.state = "paused";
                record.generation++;
                this.suspended = true;
                this.suspendOwner = record.requester;
                this.suspensionReason = "review";
                lease.abort.abort();
            }
            throw error;
        } finally {
            if (pending) lease.pending.delete(pending);
            if (atomic && !nested) lease.atomicLock = false;
            if (irreversible)
                operation.inventoryAfter = this.bot.inventory
                    ?.items()
                    .map((i) => ({ name: i.name, count: i.count }));
            this.save();
        }
        if (!nested) this.check();
        return result;
    }

    abortable(promise, lease = this.context.getStore()) {
        if (!lease) return Promise.resolve(promise);
        return new Promise((resolve, reject) => {
            const abort = () => reject(new TaskInterrupted());
            lease.abort.signal.addEventListener("abort", abort, { once: true });
            Promise.resolve(promise)
                .then(resolve, reject)
                .finally(() =>
                    lease.abort.signal.removeEventListener("abort", abort)
                );
            if (lease.abort.signal.aborted) abort();
        });
    }

    async interrupt() {
        this.cleanupCount++;
        try {
            const lease = this.lease;
            if (lease) lease.abort.abort();
            this.bot.pathfinder?.setGoal(null);
            this.bot.pvp?.stop();
            this.bot.hawkEye?.stop();
            this.bot.deactivateItem?.();
            this.bot.clearControlStates?.();
            const cleanup = [
                this.bot.stopDigging?.(),
                this.bot.collectBlock?.cancelTask?.(),
            ];
            // Do not close an inventory window midway through an irreversible transaction.
            if (
                !lease?.action.operations.some(
                    (o) => (o.atomic || o.irreversible) && o.state === "started"
                ) &&
                this.bot.currentWindow
            ) {
                cleanup.push(this.bot.closeWindow(this.bot.currentWindow));
            }
            if (this.bot.isSleeping) cleanup.push(this.bot.wake?.());
            await Promise.allSettled(cleanup);
        } finally {
            this.cleanupCount--;
        }
    }

    finishAction(lease, results, error = null) {
        lease.closing = true;
        const finish = () => {
            lease.finished = true;
            lease.action.state = lease.abort.signal.aborted
                ? "interrupted"
                : error
                ? "failed"
                : "completed";
            lease.action.results = results || [];
            lease.action.error = error?.message || null;
            const record = lease.taskId ? this.get(lease.taskId) : null;
            if (record) record.updated = new Date().toISOString();
            if (this.lease === lease) this.lease = null;
            this.save();
            this.movementModes.dispatch();
        };
        if (lease.pending.size)
            return Promise.allSettled([...lease.pending]).then(finish);
        finish();
    }

    install() {
        const bot = this.bot;
        bot.movementModes = this.movementModes;
        bot.resolveTarget = reference => {
            const lease = this.context.getStore();
            const task = lease?.taskId && this.get(lease.taskId);
            return resolveWorldTarget(bot, reference, { requester: task?.requester, memories: lease?.targetMemory || [] });
        };
        bot.checkTask = () => this.check();
        bot.taskSignal = () => this.context.getStore()?.abort.signal;
        bot.taskAwait = (promise) => this.abortable(promise);
        bot.taskSleep = async (ms) => {
            this.check();
            const lease = this.context.getStore();
            let timer;
            try {
                await this.abortable(
                    new Promise((resolve) => {
                        timer = setTimeout(resolve, ms);
                    }),
                    lease
                );
            } finally {
                clearTimeout(timer);
            }
            this.check();
        };
        const wrap = (object, method, irreversible = false) => {
            if (typeof object?.[method] !== "function") return;
            const original = object[method].bind(object);
            object[method] = (...args) =>
                this.operation(method, () => original(...args), irreversible);
        };
        for (const name of [
            "dig",
            "placeBlock",
            "craft",
            "equip",
            "consume",
            "fish",
            "sleep",
            "activateBlock",
            "useOn",
            "waitForTicks",
        ])
            wrap(bot, name);
        for (const name of ["toss", "tossStack", "transfer"])
            wrap(bot, name, true);
        for (const method of ["setGoal", "setMovements"]) {
            if (!bot.pathfinder?.[method]) continue;
            const original = bot.pathfinder[method].bind(bot.pathfinder);
            bot.pathfinder[method] = (...args) => {
                try {
                    this.check();
                } catch (error) {
                    if (error instanceof TaskInterrupted) return;
                    throw error;
                }
                return original(...args);
            };
        }
        wrap(bot.pathfinder, "goto");
        wrap(bot.collectBlock, "collect");
        wrap(bot.pvp, "attack");
        for (const name of [
            "attack",
            "activateItem",
            "setControlState",
            "save",
            "chat",
        ]) {
            if (!bot[name]) continue;
            const original = bot[name].bind(bot);
            bot[name] = (...args) => {
                try {
                    this.check();
                } catch (error) {
                    if (error instanceof TaskInterrupted) return;
                    throw error;
                }
                return original(...args);
            };
        }
        for (const name of ["openContainer", "openFurnace"]) {
            if (!bot[name]) continue;
            const original = bot[name].bind(bot);
            bot[name] = async (...args) => {
                const window = await this.operation(name, () =>
                    original(...args)
                );
                for (const method of [
                    "withdraw",
                    "deposit",
                    "putInput",
                    "putFuel",
                    "takeOutput",
                    "takeInput",
                    "takeFuel",
                ])
                    wrap(window, method, true);
                return window;
            };
        }
        this.movementModes.ready = true;
    }
}

function parseControl(text, username) {
    if (typeof text !== "string") return null;
    const escaped = (username || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const addressed = escaped
        ? text.replace(
              new RegExp(
                  `^@?${escaped}[,:!]?\\s+|[, ]+@?${escaped}[.!?]?$`,
                  "ig"
              ),
              ""
          )
        : text;
    const input = addressed.trim().replace(/[.!?]+$/, "")
        .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, "");
    const match = input
        .trim()
        .replace(/[.!?]+$/, "")
        .match(
            new RegExp(`^(?:please\\s+)?(${CONTROLS.flatMap(c => [c.name, ...(c.aliases || [])]).join("|")})(?:\\s+(?:task\\s+)?([a-f0-9-]{8,36}))?$`, "i")
        );
    if (match) {
        const name = match[1].toLowerCase();
        const control = CONTROLS.find(c => c.name === name || c.aliases?.includes(name));
        if (control.name === "cmds" && match[2]) return null;
        return { command: control.name, id: match[2] || null };
    }
    const natural = input
        .trim()
        .replace(/[.!?]+$/, "")
        .match(
            /^(?:please\s+)?(stop|pause|cancel|resume|continue)\s+(?:(?:the|this|that|my)\s+)?(?:current\s+)?(?:task|work|working|moving|building|attacking|everything)$/i
        );
    if (natural)
        return {
            command:
                natural[1].toLowerCase() === "continue"
                    ? "resume"
                    : natural[1].toLowerCase(),
            id: null,
        };
    const phrase = addressed.trim().replace(/[.!?]+$/, "").toLowerCase();
    const control = CONTROLS.find(c => c.phrases?.includes(phrase));
    if (control) return { command: control.name, id: null };
    return null;
}
module.exports = { TaskController, TaskInterrupted, parseControl };
