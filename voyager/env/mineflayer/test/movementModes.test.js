const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Movements, goals: { GoalFollow, GoalNear } } = require('mineflayer-pathfinder');
const { TaskController } = require('../lib/tasks');
const mcData = require('minecraft-data')('1.21.11');
const settle = () => new Promise(setImmediate);

function scene(t, journalPath = null) {
    const bot = Object.assign(new EventEmitter(), { registry: mcData, username: 'Voyager', health: 20, game: { dimension: 'overworld' },
        entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [] },
        players: { Alice: { username: 'Alice', entity: { username: 'Alice', id: 1, position: new Vec3(2, 64, 0) } } },
        clearControlStates() {}, pathCalls: [] });
    bot.pathfinder = { movements: new Movements(bot), goal: null,
        setMovements(m) { this.movements = m; }, setGoal(goal, dynamic) { this.goal = goal; bot.pathCalls.push({ goal, dynamic }); } };
    const controller = bot.tasks = new TaskController(bot, { journalPath });
    controller.install();
    controller.movementModes.pollMs = 2;
    t.after(async () => { bot.emit('end'); await settle(); });
    return { bot, controller, modes: controller.movementModes };
}

test('following owns the task lease and cancellation leaves no late movement callback', async t => {
    const { bot, controller, modes } = scene(t);
    const result = modes.request({ mode: 'follow', requester: 'Alice' });
    assert.equal(result.ok, true);
    assert.equal(controller.snapshot().busy, true);
    assert.ok(bot.pathfinder.goal instanceof GoalFollow);
    assert.equal(bot.pathCalls[0].dynamic, true);
    assert.equal(bot.pathfinder.movements.canDig, false);
    const task = controller.get(result.id);
    await controller.control('stop', 'Alice');
    await settle();
    assert.equal(task.state, 'cancelled');
    assert.equal(bot.pathfinder.goal, null);
    assert.equal(modes.running, null);
    assert.equal(controller.lease, null);
});

test('foreground work temporarily yields following, which resumes after the foreground task', async t => {
    const { bot, controller, modes } = scene(t);
    const following = modes.request({ mode: 'follow', requester: 'Alice' });
    const foreground = controller.enqueue({ task: 'Bring Alice supplies', requester: 'Alice' });
    assert.equal(controller.get(following.id).state, 'queued');
    assert.equal(controller.claim(foreground.id), null); // Old lease has not settled yet.
    await settle();
    assert.equal(controller.claim(foreground.id).state, 'running');
    assert.equal(modes.running, null);
    controller.complete(foreground.id, foreground.generation, true);
    controller.snapshot();
    assert.equal(controller.active().id, following.id);
    assert.ok(bot.pathfinder.goal instanceof GoalFollow);
});

test('temporarily lost players halt movement, then resume on loaded reappearance or fail after a bounded wait', async t => {
    const { bot, controller, modes } = scene(t);
    modes.lostMs = 15;
    let now = 0;
    modes.now = () => now;
    const result = modes.request({ mode: 'follow', requester: 'Alice' });
    bot.players.Alice.entity.isValid = false;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(bot.pathfinder.goal, null);
    bot.players.Alice.entity = { username: 'Alice', id: 2, position: new Vec3(3, 64, 0) };
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(bot.pathfinder.goal instanceof GoalFollow);
    bot.players.Alice.entity.isValid = false;
    await new Promise(resolve => setTimeout(resolve, 5));
    now = 20;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(controller.get(result.id).state, 'failed');
    assert.match(controller.get(result.id).reason, /Lost Alice/);
    assert.equal(bot.pathfinder.goal, null);
});

test('stay holds its anchor, low health pauses safely and stop/resume following is owned', async t => {
    const { bot, controller, modes } = scene(t);
    const following = modes.request({ mode: 'follow', requester: 'Alice' });
    assert.equal(modes.request({ mode: 'stop_following', requester: 'Bob' }).ok, false);
    assert.equal(modes.request({ mode: 'stop_following', requester: 'Alice', key: 'stop-mode' }).ok, true);
    await settle();
    assert.equal(controller.get(following.id).state, 'cancelled');
    modes.request({ mode: 'resume_following', requester: 'Alice' });
    await settle();
    assert.ok(bot.pathfinder.goal instanceof GoalFollow);
    // An ambiguous delivery retry must not stop the newly resumed mode.
    modes.request({ mode: 'stop_following', requester: 'Alice', key: 'stop-mode' });
    assert.ok(bot.pathfinder.goal instanceof GoalFollow);
    const stay = modes.request({ mode: 'stay', requester: 'Alice' });
    await settle();
    assert.ok(bot.pathfinder.goal instanceof GoalNear);
    bot.pathfinder.goal = null; bot.entity.position.x = 3;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(bot.pathfinder.goal instanceof GoalNear);
    bot.health = 4;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(controller.get(stay.id).state, 'paused');
    assert.equal(controller.suspensionReason, 'safety');
    assert.equal(bot.pathfinder.goal, null);
});

test('persistent modes recover automatically on rejoin with a fresh generation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-movement-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const journalPath = path.join(directory, 'tasks.json');
    const first = scene(t, journalPath);
    const result = first.modes.request({ mode: 'follow', requester: 'Alice' });
    const generation = first.controller.get(result.id).generation;
    first.bot.emit('end');
    await settle();
    const next = scene(t, journalPath);
    assert.equal(next.controller.suspended, false);
    next.controller.snapshot();
    assert.equal(next.controller.active().id, result.id);
    assert.ok(next.controller.active().generation > generation);
    assert.ok(next.bot.pathfinder.goal instanceof GoalFollow);
});

test('unreachable destinations fail without destructive fallback movement', async t => {
    const { bot, controller, modes } = scene(t);
    let now = 0;
    modes.now = () => now;
    modes.stuckMs = 10;
    const stay = modes.request({ mode: 'stay', requester: 'Alice', reference: { type: 'coordinates', position: { x: 20, y: 64, z: 0 } } });
    now = 20;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(controller.get(stay.id).state, 'failed');
    assert.match(controller.get(stay.id).reason, /unreachable/);
    assert.equal(bot.pathfinder.goal, null);
});
