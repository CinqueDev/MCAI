const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
    TaskController,
    TaskInterrupted,
    parseControl,
} = require("../lib/tasks");
const { Conversation } = require("../lib/conversation");

function fixture(options = {}) {
    const bot = new EventEmitter();
    Object.assign(bot, {
        username: "Voyager",
        players: { Alice: {}, Bob: {}, Voyager: {} },
        results: [],
        chat(text) {
            this.results.push(text);
        },
        clearControlStates() {},
        inventory: { items: () => [] },
        pathfinder: {
            setGoal(goal) {
                this.goal = goal;
            },
            goto: () => new Promise(() => {}),
        },
        pvp: {
            stop() {
                bot.emit("stoppedAttacking");
            },
        },
        hawkEye: {
            stop() {
                bot.emit("auto_shot_stopped");
            },
        },
        collectBlock: { cancelTask: async () => {} },
    });
    bot.conversation = new Conversation(bot, Date.now, { interval: 0 });
    bot.tasks = new TaskController(bot, options);
    bot.tasks.install();
    return { bot, controller: bot.tasks };
}
function start(controller, values = {}) {
    const task = controller.enqueue({
        task: "Bring Alice supplies",
        requester: "Alice",
        ...values,
    });
    return controller.claim(task.id);
}
function begin(controller, task) {
    return controller.beginAction({ id: task.id, generation: task.generation });
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("controls recognize exact addressed commands without treating discussion as instructions", () => {
    assert.deepEqual(parseControl("Voyager, please stop!", "Voyager"), {
        command: "stop",
        id: null,
    });
    assert.equal(
        parseControl("cancel task abcdef12", "Voyager").id,
        "abcdef12"
    );
    assert.equal(
        parseControl("What are you doing?", "Voyager").command,
        "status"
    );
    assert.equal(parseControl('Alice said "stop"', "Voyager"), null);
    assert.equal(parseControl("don't stop building", "Voyager"), null);
});

test("private chat stop cancels navigation immediately and replies by /msg without a model", async () => {
    const { bot, controller } = fixture();
    const task = start(controller);
    const lease = begin(controller, task);
    const walking = controller.context.run(lease, () =>
        bot.pathfinder.goto({})
    );
    const stopped = assert.rejects(walking, TaskInterrupted);
    bot.emit("whisper", "Alice", "stop");
    await stopped;
    await settle();
    assert.equal(controller.get(task.id).state, "cancelled");
    assert.equal(controller.suspended, true);
    assert.equal(bot.pathfinder.goal, null);
    assert.ok(bot.results[0].startsWith("/msg Alice Stopped"));
    controller.finishAction(lease, []);
});

test("pause preserves receipts, invalidates old leases and resume permits only a fresh generation", async () => {
    const { controller } = fixture();
    const task = start(controller);
    const oldGeneration = task.generation;
    const lease = begin(controller, task);
    await controller.control("pause", "Alice");
    controller.finishAction(lease, [{ type: "place", verified: true }]);
    await controller.control("resume", "Alice");
    assert.equal(task.actions[0].results[0].type, "place");
    assert.throws(
        () =>
            controller.beginAction({ id: task.id, generation: oldGeneration }),
        TaskInterrupted
    );
    const next = begin(controller, task);
    assert.equal(task.state, "running");
    controller.finishAction(next, []);
});

test("other players cannot cancel work and private descriptions never appear in public status", async () => {
    const { controller } = fixture({ operators: ["Owner"] });
    const task = start(controller, {
        recipient: "Alice",
        task: "secret project",
    });
    assert.match(await controller.control("cancel", "Bob"), /requester/);
    assert.equal(task.state, "running");
    assert.ok(
        !(await controller.control("status", "Alice")).includes("secret")
    );
    assert.ok(
        (await controller.control("status", "Alice", null, "private")).includes(
            "secret"
        )
    );
    await controller.control("stop", "Owner");
    assert.equal(task.state, "cancelled");
});

test("late asynchronous operations cannot act after cancellation or steal a new task's goal", async () => {
    const { bot, controller } = fixture();
    const task = start(controller);
    const lease = begin(controller, task);
    let late;
    const callback = new Promise((resolve) => {
        controller.context.run(lease, () => {
            late = setTimeout(() => {
                bot.pathfinder.setGoal({ stale: true });
                resolve();
            }, 10);
        });
    });
    await controller.control("cancel", "Alice");
    controller.finishAction(lease, []);
    const nextTask = start(controller, { task: "New task" });
    const next = begin(controller, nextTask);
    bot.pathfinder.setGoal({ fresh: true });
    await callback;
    assert.deepEqual(bot.pathfinder.goal, { fresh: true });
    assert.equal(controller.complete(task.id, lease.generation, true), false);
    controller.finishAction(next, []);
});

test("atomic item operations settle before stopping and later operations are blocked", async () => {
    const { bot, controller } = fixture();
    let release;
    bot.toss = () =>
        new Promise((resolve) => {
            release = resolve;
        });
    // Install this operation after replacing the test transport.
    const task = start(controller);
    const lease = begin(controller, task);
    const dropping = controller.context.run(lease, () =>
        controller.operation("toss", () => bot.toss(), true)
    );
    const stopped = assert.rejects(dropping, TaskInterrupted);
    await controller.control("pause", "Alice");
    assert.equal(lease.action.operations[0].state, "started");
    release();
    await stopped;
    assert.equal(lease.action.operations[0].state, "completed");
    assert.equal(task.needsReview, undefined);
    controller.finishAction(lease, []);
});

test("interrupted inventory operations require review rather than being replayed", async () => {
    const { controller } = fixture();
    const task = start(controller);
    const lease = begin(controller, task);
    await assert.rejects(
        controller.context.run(lease, () =>
            controller.operation(
                "withdraw",
                async () => {
                    throw new Error("lost acknowledgement");
                },
                true
            )
        )
    );
    assert.equal(task.needsReview, true);
    assert.equal(task.state, "paused");
    controller.finishAction(lease, []);
    assert.match(
        await controller.control("resume", "Alice"),
        /inventory review/
    );
});

test("journal automatically requeues safe work with progress after process restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcai-tasks-"));
    try {
        const journalPath = path.join(directory, "tasks.json");
        const first = fixture({ journalPath }).controller;
        const task = start(first);
        const lease = begin(first, task);
        lease.action.results.push({ type: "place", verified: true });
        first.enqueue({ task: "Second task", requester: "Bob" });
        first.save();
        const second = fixture({ journalPath }).controller;
        assert.equal(second.get(task.id).state, "queued");
        assert.equal(second.suspended, false);
        assert.equal(second.get(task.id).actions[0].results[0].type, "place");
        assert.equal(
            second.records.filter((t) => t.state === "queued").length,
            2
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("queue priorities, yielding and stale social decisions preserve task ownership", async () => {
    const { controller } = fixture();
    const auto = start(controller, {
        requester: null,
        task: "Curriculum",
        priority: 0,
    });
    const player = controller.enqueue({
        task: "Player request",
        requester: "Alice",
    });
    assert.equal(controller.yieldTask(auto.id, auto.generation), true);
    assert.equal(controller.claim().id, player.id);
    const revision = controller.revision;
    await controller.control("stop", "Alice");
    assert.equal(
        controller.enqueue({
            task: "Stale model output",
            requester: "Alice",
            expectedRevision: revision,
        }),
        null
    );
});

test("exploration and combat remove listeners and timers on cancellation", async () => {
    const { bot, controller } = fixture();
    bot.entity = { position: { x: 0, y: 64, z: 0 } };
    const context = vm.createContext({
        bot,
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
    });
    for (const file of ["exploreUntil", "waitForMobRemoved"]) {
        vm.runInContext(
            fs.readFileSync(
                path.join(
                    __dirname,
                    "../../../control_primitives",
                    file + ".js"
                ),
                "utf8"
            ),
            context
        );
    }
    const task = start(controller);
    const lease = begin(controller, task);
    const exploration = controller.context.run(lease, () =>
        vm.runInContext("exploreUntil(bot, {x:1,y:0,z:0}, 60)", context)
    );
    const combat = controller.context.run(lease, () =>
        vm.runInContext('waitForMobRemoved(bot, {name:"zombie"}, 60)', context)
    );
    const explored = assert.rejects(exploration, /stopped/);
    const fought = assert.rejects(combat, /stopped/);
    await controller.control("stop", "Alice");
    await Promise.all([explored, fought]);
    assert.equal(bot.listenerCount("entityGone"), 0);
    assert.equal(bot.listenerCount("itemDrop"), 0);
    controller.finishAction(lease, []);
});

test("a queued task cannot be used to pause or resume another player's active task", async () => {
    const { controller } = fixture();
    const active = start(controller, { requester: "Bob" });
    const queued = controller.enqueue({
        task: "Alice queued work",
        requester: "Alice",
    });
    assert.match(
        await controller.control("pause", "Alice", queued.id),
        /active task/
    );
    assert.equal(active.state, "running");
    assert.equal(controller.suspended, false);
});


test("bounded natural controls recognize stop building and resume my task", () => {
    assert.equal(parseControl("Voyager, stop building", "Voyager").command, "stop");
    assert.equal(parseControl("resume my task", "Voyager").command, "resume");
    assert.equal(parseControl("Please don't stop working", "Voyager"), null);
});

test("an active atomic transaction cannot authorize a sibling operation after stop", async () => {
    const { controller } = fixture();
    const task = start(controller);
    const lease = begin(controller, task);
    let release, completed = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const original = controller.context.run(lease, () => controller.operation("toss", async () => {
        await gate;
        await controller.operation("transfer", async () => { completed++; }, true);
    }, true));
    const interrupted = assert.rejects(original, TaskInterrupted);
    await controller.control("pause", "Alice");
    await assert.rejects(controller.context.run(lease, () => controller.operation("toss", async () => { completed += 100; }, true)), TaskInterrupted);
    release();
    await interrupted;
    assert.equal(completed, 1);
    controller.finishAction(lease, []);
});

test("action completion keeps the lease until an outstanding atomic operation settles", async () => {
    const { controller } = fixture();
    const task = start(controller);
    const lease = begin(controller, task);
    let release;
    const pending = controller.context.run(lease, () => controller.operation("toss", () => new Promise(resolve => { release = resolve; }), true));
    const rejected = assert.rejects(pending, TaskInterrupted);
    const finishing = controller.finishAction(lease, []);
    assert.equal(controller.lease, lease);
    release();
    await Promise.all([finishing, rejected]);
    assert.equal(controller.lease, null);
});

test("queue and status explain intentional pauses and normal planning", async () => {
    const { controller } = fixture();
    controller.planning = true;
    assert.match(await controller.control("status", "Alice"), /Planning/);
    const task = start(controller);
    controller.enqueue({ task: "Next request", requester: "Alice" });
    await controller.control("pause", "Alice");
    assert.match(await controller.control("queue", "Alice"), /resume is needed/);
    assert.match(await controller.control("cancel", "Alice", task.id), /remains paused/);
});

test('current-task and named cancellations interrupt real work and acknowledge controller state', async () => {
    for (const text of ['cancel the current task', 'Can you cancel the current task?']) {
        const { bot, controller } = fixture();
        const task = start(controller, { task: 'Break the beehive near Alice' });
        const lease = begin(controller, task);
        const walking = controller.context.run(lease, () => bot.pathfinder.goto({}));
        const interrupted = assert.rejects(walking, TaskInterrupted);
        bot.emit('whisper', 'Alice', text);
        await interrupted;
        await settle();
        assert.equal(controller.get(task.id).state, 'cancelled');
        assert.ok(bot.results[0].startsWith('/msg Alice Cancelled'));
        assert.deepEqual(bot.conversation.snapshot().pending, []);
    }
});

test('named controls clarify ambiguity and cannot select another player or expose private tasks', async () => {
    const { controller } = fixture();
    const one = controller.enqueue({ task: 'Break a beehive', requester: 'Alice' });
    const two = controller.enqueue({ task: 'Find a beehive', requester: 'Alice' });
    controller.enqueue({ task: 'Secret beehive location', requester: 'Bob', recipient: 'Bob' });
    const before = controller.revision;
    assert.match(await controller.control('cancel', 'Alice', null, 'public', 'beehive'), /More than one/);
    assert.equal(one.state, 'queued');
    assert.equal(two.state, 'queued');
    assert.equal(controller.revision, before);
    assert.match(await controller.control('cancel', 'Alice', null, 'public', 'secret'), /No active or queued/);
    assert.match(await controller.control('cancel', 'Bob', null, 'public', 'beehive'), /No active or queued/);
    assert.match(await controller.control('cancel', 'Alice', null, 'public', 'break beehive'), /Cancelled/);
    assert.equal(one.state, 'cancelled');
    assert.equal(two.state, 'queued');
    for (const text of ['Alice said cancel the beehive task', "don't cancel the beehive task", 'if needed cancel the beehive task']) {
        assert.equal(parseControl(text, 'Voyager'), null);
    }
});

test('rejoining preserves manual pauses but only blocks automatic recovery for uncertain item operations', async () => {
    for (const kind of ['manual', 'transfer', 'safe']) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-rejoin-'));
        try {
            const journalPath = path.join(directory, 'tasks.json');
            const { bot, controller } = fixture({ journalPath });
            const task = start(controller);
            const lease = begin(controller, task);
            if (kind === 'manual') await controller.control('pause', 'Alice');
            if (kind === 'transfer') {
                lease.action.operations.push({ name: 'toss', irreversible: true, state: 'started' });
                controller.save();
            }
            bot.emit('end');
            const recovered = fixture({ journalPath }).controller;
            assert.equal(recovered.get(task.id).state, kind === 'safe' ? 'queued' : 'paused');
            assert.equal(recovered.suspended, kind !== 'safe');
            if (kind === 'transfer') {
                assert.equal(recovered.get(task.id).needsReview, true);
                assert.match(await recovered.control('resume', 'Alice'), /inventory review/);
            }
            // A callback from the disconnected generation cannot overwrite the new journal.
            controller.finishAction(lease, []);
            const again = fixture({ journalPath }).controller;
            assert.equal(again.get(task.id).state, recovered.get(task.id).state);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
});

test('native control receipts are idempotent, durable and reject stale or ambiguous selections', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-control-receipts-'));
    try {
        const journalPath = path.join(directory, 'tasks.json');
        const controller = fixture({ journalPath }).controller;
        const first = start(controller, { task: 'Break the beehive' });
        const request = { command: 'cancel', sender: 'Alice', target: 'beehive', channel: 'private', key: 'receipt', expectedRevision: controller.revision };
        const receipt = await controller.executeControl(request);
        assert.equal(receipt.ok, true);
        assert.equal(first.state, 'cancelled');
        const next = controller.enqueue({ task: 'Break another beehive', requester: 'Alice' });
        controller.claim(next.id);
        assert.deepEqual(await controller.executeControl(request), receipt);
        assert.equal(next.state, 'running');
        const recovered = fixture({ journalPath }).controller;
        assert.deepEqual(await recovered.executeControl(request), receipt);
        assert.equal(recovered.get(next.id).state, 'queued');
        const stale = await recovered.executeControl({ ...request, key: 'stale' });
        assert.equal(stale.ok, false);
        assert.match(stale.message, /Work changed/);
        await assert.rejects(recovered.executeControl({ ...request, command: 'stop' }), /reused/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('uninterpreted player input blocks new autonomous actions and queue reports the pending interpretation', async () => {
    const {bot,controller} = fixture();
    const mining = controller.enqueue({task:'Mine iron',priority:0});
    controller.claim(mining.id);
    bot.emit('chat','Alice','Hey come over here');
    assert.throws(()=>controller.beginAction({id:mining.id,generation:mining.generation}),TaskInterrupted);
    assert.equal(mining.state,'queued');
    assert.equal(controller.claim(mining.id),null);
    const status = await controller.control('status','Alice');
    assert.match(status,/Interpreting/);
    const approach = controller.enqueue({task:'Approach Alice',requester:'Alice'});
    assert.equal(controller.claim().id,approach.id);
});
