const { setPaused } = require("./pause");
const { Movements, goals: { GoalFollow, GoalNear } } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { playerEntity } = require('./playerState');
const { resolveWorldTarget, dimension } = require('./targetResolver');

// Persistent movement owns a normal task/action lease. Foreground work yields it
// at a safe boundary; no independent goal is allowed to compete with that lease.
class MovementModes {
    constructor(controller, { pollMs = 500, lostMs = 15000, stuckMs = 30000, now = Date.now } = {}) {
        this.controller = controller;
        this.bot = controller.bot;
        this.now = now;
        this.pollMs = pollMs;
        this.lostMs = lostMs;
        this.stuckMs = stuckMs;
        this.running = null;
        this.ready = false;
    }
    resolve(mode, reference, options, distance = 2) {
        if (!['follow', 'stay'].includes(mode)) throw new Error('Unsupported movement mode');
        if (!Number.isFinite(distance) || distance < 1 || distance > 8) throw new Error('Following distance must be 1-8 blocks');
        const ref = reference || (mode === 'follow' ? { type: 'player', name: options.requester } :
            { type: 'coordinates', position: this.bot.entity?.position, dimension: this.bot.game?.dimension });
        const target = resolveWorldTarget(this.bot, ref, options);
        if (target.status !== 'resolved') throw new Error(target.reason);
        if (mode === 'follow' && target.kind !== 'player') throw new Error('Following needs a visible player, not a fixed location');
        return { mode, target, distance };
    }
    request(request) {
        const key = request.key;
        const signature = JSON.stringify({ mode: request.mode, reference: request.reference, distance: request.distance,
            requester: request.requester, recipient: request.recipient });
        if (key && this.controller.controlReceipts[key]) {
            const old = this.controller.controlReceipts[key];
            if (old.signature !== signature) throw new Error('Movement key reused for another request');
            return old.result;
        }
        const result = this._request(request);
        if (key) {
            this.controller.controlReceipts[key] = { signature, result };
            const keys = Object.keys(this.controller.controlReceipts);
            for (const old of keys.slice(0, Math.max(0, keys.length - 1000))) delete this.controller.controlReceipts[old];
            this.controller.save();
        }
        return result;
    }
    _request({ mode, reference, distance = 2, requester, recipient = null, memories = [], requesterLocation = null, requesterDimension = null, key = null }) {
        const controller = this.controller;
        if (!/^[A-Za-z0-9_]{1,16}$/.test(requester || '') || (recipient !== null && recipient !== requester)) throw new Error('Invalid movement requester/channel');
        if (key) {
            const existing = controller.records.find(t => t.key === key);
            if (existing) return { ok: true, id: existing.id, message: `Movement request already recorded as ${existing.id.slice(0, 8)} (${existing.state}).` };
        }
        const owned = controller.records.filter(t => t.movement && t.requester?.toLowerCase() === requester.toLowerCase());
        if (mode === 'stop_following') {
            const matches = owned.filter(t => t.movement.mode === 'follow' && ['running', 'queued', 'paused'].includes(t.state));
            if (!matches.length) return { ok: false, message: 'You have no active or queued following request.' };
            for (const task of matches) { task.state = 'cancelled'; task.generation++; }
            controller.revision++;
            controller.save();
            if (matches.some(t => t.id === this.running?.record.id)) controller.interrupt().catch(() => {});
            return { ok: true, message: 'Stopped following. Other foreground tasks are unchanged.' };
        }
        if (mode === 'resume_following') {
            const previous = owned.filter(t => t.movement.mode === 'follow').at(-1);
            if (!previous) return { ok: false, message: 'There is no previous following request to resume.' };
            if (controller.suspended) return { ok: false, message: 'Work is deliberately paused/stopped. Say resume first, then ask to follow again.' };
            mode = 'follow'; reference = { type: 'player', name: previous.movement.target.player }; distance = previous.movement.distance;
        }
        const config = this.resolve(mode, reference, { requester, memories, requesterLocation, requesterDimension }, distance);
        const description = mode === 'follow' ? `Follow ${config.target.player} at ${distance} blocks` :
            `Stay at ${Object.values(config.target.position).join(', ')} in ${config.target.dimension}`;
        const task = controller.enqueue({ task: description, requester, recipient, priority: 50, key });
        task.movement = config;
        // A new mode from the same owner replaces their previous mode, including a
        // mode temporarily queued behind foreground work.
        for (const previous of owned.filter(t => t.id !== task.id && ['running', 'queued', 'paused'].includes(t.state))) {
            previous.state = 'cancelled'; previous.generation++;
            if (this.running?.record.id === previous.id) controller.interrupt().catch(() => {});
        }
        controller.save();
        this.dispatch();
        return { ok: true, id: task.id, message: `${task.state === 'running' ? 'Started' : 'Queued'}: ${description}. Use stop/pause/cancel to control it.` };
    }
    assign(mode, reference, distance = 2) {
        const lease = this.controller.context.getStore();
        const record = lease?.taskId && this.controller.get(lease.taskId);
        this.controller.check();
        if (!record?.requester) throw new Error('Persistent movement needs an explicit player task');
        const config = this.resolve(mode, reference, { requester: record.requester, memories: lease.targetMemory || [] }, distance);
        record.movement = config;
        record.priority = 50;
        this.controller.save();
        const result = { type: 'movement_mode', mode, target: config.target, persistent: true, verified: true };
        (this.bot.actionResults ||= []).push(result);
        return result;
    }
    yieldForForeground(task) {
        const active = this.controller.active();
        if (!active?.movement || !task.requester || task.priority <= active.priority || task.id === active.id) return;
        active.state = 'queued'; active.generation++;
        this.controller.revision++;
        this.controller.save();
        this.controller.interrupt().catch(() => {});
    }
    dispatch() {
        const controller = this.controller;
        if (!this.ready || this.running || controller.disconnected || controller.suspended || controller.lease || controller.cleanupCount) return;
        let record = controller.active();
        if (!record) {
            const next = controller.records.filter(t => t.state === 'queued').sort((a, b) => b.priority - a.priority)[0];
            if (!next?.movement) return;
            record = controller.claim(next.id);
        }
        if (!record?.movement || record.state !== 'running') return;
        const lease = controller.beginAction({ id: record.id, generation: record.generation });
        this.running = { record, lease };
        const previous = this.bot.pathfinder.movements;
        controller.context.run(lease, () => this.run(record)).catch(error => {
            if (lease.abort.signal.aborted || controller.disconnected) return;
            if (controller.complete(record.id, lease.generation, false, error.message)) this.notify(record, error.message);
        }).finally(() => {
            controller.context.exit(() => {
                this.bot.pathfinder.setGoal(null);
                this.bot.clearControlStates?.();
                if (previous) this.bot.pathfinder.setMovements(previous);
                this.running = null;
                controller.finishAction(lease, this.bot.actionResults || []);
                this.dispatch();
            });
        });
    }
    notify(record, text) {
        const conversation = this.bot.conversation;
        if (!conversation || this.controller.disconnected) return;
        Promise.resolve(conversation.send({ session: conversation.session, key: `movement:${record.id}:${record.generation}:${record.state}`,
            recipient: record.recipient, text })).catch(() => {});
    }
    async run(record) {
        const { bot, controller } = this;
        const config = record.movement;
        if (bot.serverPaused) {
            await setPaused(bot, bot.pauseMode, false);
            bot.serverPaused = false;
            controller.check();
        }
        const movements = new Movements(bot);
        movements.canDig = false;
        movements.allow1by1towers = false;
        movements.allowFreeMotion = false;
        movements.scafoldingBlocks = [];
        bot.pathfinder.setMovements(movements);
        let tracked = null, lostAt = null, lastPosition = bot.entity.position.clone(), progressedAt = this.now();
        while (true) {
            controller.check();
            if (dimension(bot.game?.dimension) !== dimension(config.target.dimension)) throw new Error('Movement stopped because the dimension changed; portal travel is unsupported.');
            if (bot.health <= 6 || bot.entity.isInLava) {
                record.state = 'paused'; record.generation++;
                controller.suspended = true; controller.suspendOwner = record.requester;
                controller.suspensionReason = 'safety'; controller.revision++;
                controller.save();
                this.notify(record, 'Movement paused because I am in danger. Check the situation, then resume when safe.');
                controller.lease.abort.abort();
                return;
            }
            let targetPosition, range;
            if (config.mode === 'follow') {
                const player = playerEntity(bot, config.target.player);
                if (!player) {
                    if (lostAt === null) { lostAt = this.now(); bot.pathfinder.setGoal(null); bot.clearControlStates?.(); tracked = null; }
                    if (this.now() - lostAt >= this.lostMs) throw new Error(`Lost ${config.target.player}; stopped after waiting for their loaded entity. Ask me to follow again when nearby.`);
                    await bot.taskSleep(this.pollMs);
                    continue;
                }
                lostAt = null;
                targetPosition = player.position; range = config.distance;
                if (tracked !== player) { bot.pathfinder.setGoal(new GoalFollow(player, range), true); tracked = player; }
            } else {
                targetPosition = new Vec3(config.target.position.x, config.target.position.y, config.target.position.z);
                range = 1;
                if (!tracked || (bot.entity.position.distanceTo(targetPosition) > range + 0.5 && !bot.pathfinder.goal)) { bot.pathfinder.setGoal(new GoalNear(targetPosition.x, targetPosition.y, targetPosition.z, range)); tracked = true; }
            }
            if (bot.entity.position.distanceTo(lastPosition) > 0.25 || bot.entity.position.distanceTo(targetPosition) <= range + 1) {
                lastPosition = bot.entity.position.clone(); progressedAt = this.now();
            } else if (this.now() - progressedAt >= this.stuckMs) throw new Error('Movement stopped: the destination was unreachable without breaking or placing blocks.');
            await bot.taskSleep(this.pollMs);
        }
    }
}
module.exports = { MovementModes };
