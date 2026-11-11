const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { Vec3 } = require('vec3');
const { Movements, goals: { GoalNear, GoalPlaceBlock } } = require('mineflayer-pathfinder');
const registry = require('minecraft-data')('1.21.11');
const Block = require('prismarine-block')(registry);
const { TaskController } = require('../lib/tasks');

function scene({ journalPath = null, cells = new Map(), stacks = null } = {}) {
    stacks ||= [{ name: 'cobblestone', count: 300 }, { name: 'oak_log', count: 10 }, { name: 'oak_slab', count: 10 }, { name: 'furnace', count: 2 }];
    for (const i of stacks) i.type = registry.itemsByName[i.name].id;
    const bot = Object.assign(new EventEmitter(), {
        registry, username: 'Voyager', health: 20, game: { dimension: 'overworld', minY: -64, height: 384 },
        entity: { position: new Vec3(0, 64, 0) }, players: {}, placed: [], dug: [], controls: {}, actionResults: [],
        inventory: { items: () => stacks.filter(i => i.count > 0) },
        clearControlStates() {}, getControlState(k) { return !!this.controls[k]; }, setControlState(k, v) { this.controls[k] = v; },
        async equip(i) { this.heldItem = i; }, async look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
        save() {}, log() {},
        blockAt(p) {
            p = p.floored();
            const cell = cells.get(p.toString()) || { name: p.y < 64 ? 'stone' : 'air', state: {} };
            const defaults = Block.fromStateId(registry.blocksByName[cell.name].defaultState, 0).getProperties();
            const block = Block.fromProperties(cell.name, { ...defaults, ...(cell.state || {}) }, 0); block.position = p; return block;
        },
        canDigBlock(b) { return this.entity.position.distanceTo(b.position) <= 5; },
        async dig(b) { this.dug.push(b.position.toString()); cells.set(b.position.toString(), { name: 'air' }); },
        async placeBlock(ref, face) {
            const p = ref.position.plus(face); this.placed.push(p.toString());
            cells.set(p.toString(), { name: this.heldItem.name }); this.heldItem.count--;
        },
        async _placeBlockWithOptions(ref, face, options) {
            const name = this.heldItem.name, state = {};
            if (registry.blocksByName[name].states.some(s => s.name === 'axis')) state.axis = face.x ? 'x' : face.z ? 'z' : 'y';
            if (name.endsWith('_slab')) state.type = face.y > 0 ? 'bottom' : face.y < 0 ? 'top' : options.half;
            if (name === 'furnace') state.facing = this.entity.yaw === Math.PI ? 'north' : this.entity.yaw === 0 ? 'south' : this.entity.yaw > 0 ? 'east' : 'west';
            const p = ref.position.plus(face); this.placed.push(p.toString()); cells.set(p.toString(), { name, state }); this.heldItem.count--;
        },
    });
    bot.tool = { equipForBlock: async () => { bot.heldItem = { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id }; } };
    bot.world = { getBlock: p => bot.blockAt(p) };
    bot.pathfinder = { movements: new Movements(bot), setMovements(m) { this.movements = m; }, setGoal(g) { this.goal = g; },
        async goto(g) { bot.entity.position = g instanceof GoalPlaceBlock ? g.pos.offset(2, 0, 0) : new Vec3(g.x, g.y, g.z); } };
    const controller = bot.tasks = new TaskController(bot, { journalPath }); controller.install();
    const context = vm.createContext({ bot, Vec3, Movements, GoalNear, GoalPlaceBlock, mcData: registry, setTimeout, clearTimeout });
    for (const name of ['moveToPosition', 'placeItem', 'removeBlockAt', 'replaceBlockAt', 'buildProjectBatch'])
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../control_primitives', name + '.js'), 'utf8'), context);
    const run = code => vm.runInContext(code, context);
    const create = (blocks, extra = {}) => controller.projectManager.request({ action: 'create', name: 'wall', requester: 'Alice',
        origin: { type: 'coordinates', position: { x: 4, y: 64, z: 4 } }, blocks, userText: 'Build this wall at 4,64,4', ...extra });
    const batch = async (project, limit = 128) => {
        const id = project.id || project.project.id;
        let task = controller.active() || controller.claim();
        const lease = controller.beginAction({ id: task.id, generation: task.generation });
        lease.targetMemory = [];
        try { return await controller.context.run(lease, () => run(`buildProjectBatch(bot, ${JSON.stringify(id)}, ${limit})`)); }
        finally { await controller.finishAction(lease, bot.actionResults); }
    };
    return { bot, controller, run, create, batch, cells, stacks };
}
const line = length => Array.from({ length }, (_, x) => ({ name: 'cobblestone', position: { x, y: 0, z: 0 } }));

test('persistent project survives restart and skips verified cells without duplicating materials', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-project-'));
    try {
        const journalPath = path.join(directory, 'tasks.json');
        const first = scene({ journalPath }); const project = first.create(line(3));
        const initial = first.stacks[0].count;
        const partial = await first.batch(project, 1);
        assert.equal(partial.project.completed, 1); assert.equal(partial.project.state, 'building');
        assert.equal(first.controller.complete(first.controller.active().id, first.controller.active().generation, true), false);
        first.bot.emit('end');
        const next = scene({ journalPath, cells: first.cells, stacks: first.stacks });
        const complete = await next.batch(project);
        assert.equal(complete.project.state, 'completed');
        assert.equal(complete.verified, true);
        assert.equal(next.stacks[0].count, initial - 3);
        assert.equal(next.bot.placed.length, 2);
        assert.equal(next.controller.projects[0].versions[0].approvedBy, 'Alice');
        assert.deepEqual(next.controller.projects[0].bounds, { min: { x: 4, y: 64, z: 4 }, max: { x: 6, y: 64, z: 4 } });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('player edits cause conflicts before further construction; an explicit revision can repair only that cell', async () => {
    const s = scene(); const project = s.create(line(3)); await s.batch(project, 1);
    s.cells.set(new Vec3(4, 64, 4).toString(), { name: 'dirt' });
    const blocked = await s.batch(project);
    assert.equal(blocked.project.state, 'conflict'); assert.equal(s.bot.placed.length, 1);
    assert.equal(s.bot.dug.length, 0);
    await s.controller.control('pause', 'Alice');
    const blueprint = line(3); blueprint[0] = { ...blueprint[0], action: 'replace', expected: 'dirt' };
    s.controller.projectManager.request({ action: 'revise', identifier: project.project.id, name: 'wall', requester: 'Alice',
        origin: { type: 'coordinates', position: { x: 4, y: 64, z: 4 } }, blocks: blueprint, userText: 'Replace that dirt with the wall block' });
    await s.controller.control('resume', 'Alice');
    const result = await s.batch(project);
    assert.equal(result.project.state, 'completed'); assert.equal(result.project.version, 2);
    assert.deepEqual(s.bot.dug, ['(4, 64, 4)']);
    assert.equal(s.controller.projects[0].versions.length, 2);
});

test('missing replacement materials, wrong expected blocks and unsupported states never remove a block', async () => {
    const s = scene(); s.cells.set('(4, 64, 4)', { name: 'dirt' });
    await assert.rejects(s.run('replaceBlockAt(bot, {x:4,y:64,z:4}, "stone", "cobblestone")'), /conflict/);
    await assert.rejects(s.run('replaceBlockAt(bot, {x:4,y:64,z:4}, "dirt", "diamond_block")'), /nothing was removed/);
    await assert.rejects(s.run('replaceBlockAt(bot, {x:4,y:64,z:4}, "dirt", "oak_stairs", {facing:"north"})'), /Unsupported/);
    assert.deepEqual(s.bot.dug, []);
    await s.run('removeBlockAt(bot, {x:4,y:64,z:4}, "dirt")');
    assert.deepEqual(s.bot.dug, ['(4, 64, 4)']);
});

test('supported axis, slab and furnace-facing states are placed and verified; wrong states are preserved', async () => {
    const s = scene();
    s.cells.set('(3, 64, 4)', { name: 'stone' });
    await s.run('placeItem(bot, "oak_log", {x:4,y:64,z:4}, {axis:"x"})');
    assert.equal(s.bot.blockAt(new Vec3(4,64,4)).getProperties().axis, 'x');
    s.cells.set('(5, 65, 4)', { name: 'stone' });
    await s.run('placeItem(bot, "oak_slab", {x:5,y:64,z:4}, {type:"top"})');
    assert.equal(s.bot.blockAt(new Vec3(5,64,4)).getProperties().type, 'top');
    await s.run('placeItem(bot, "furnace", {x:6,y:64,z:4}, {facing:"north"})');
    assert.equal(s.bot.blockAt(new Vec3(6,64,4)).getProperties().facing, 'north');
    await assert.rejects(s.run('placeItem(bot, "oak_log", {x:4,y:64,z:4}, {axis:"z"})'), /already occupies/);
    assert.equal(s.bot.blockAt(new Vec3(4,64,4)).getProperties().axis, 'x');
});

test('blueprint validation rejects cycles, duplicates, unapproved clearing, invalid bounds and cross-scope access', () => {
    const s = scene();
    assert.throws(() => s.create([line(1)[0], line(1)[0]]), /unique/);
    assert.throws(() => s.create([{ action: 'remove', position: {x:0,y:0,z:0} }]), /expected/);
    assert.throws(() => s.create([{ ...line(1)[0], dependsOn: [{x:0,y:0,z:0}] }]), /cycle/);
    assert.throws(() => s.create([{ name:'oak_log', state:{axis:'q'}, position:{x:0,y:0,z:0} }]), /Unsupported/);
    assert.throws(() => s.create(line(65)), /64 blocks/);
    const privateProject = s.create(line(1), { recipient: 'Alice', execute: false });
    assert.equal(s.controller.projectManager.request({ action:'list',requester:'Bob' }).projects.length, 0);
    assert.throws(() => s.controller.projectManager.request({action:'continue',requester:'Bob',identifier:privateProject.project.id}), /not found/);
    assert.throws(() => s.controller.projectManager.request({action:'continue',requester:'Alice',identifier:privateProject.project.id}), /not found/);
});

test('supplies are bounded dependencies and failed gathering cannot start the build', () => {
    const s = scene({ stacks: [] }); const project = s.create(line(60), { execute: false });
    const supplied = s.controller.projectManager.request({action:'supplies',requester:'Alice',identifier:project.project.id,key:'supplies'});
    assert.equal(supplied.ok, true);
    const supply = s.controller.claim(); assert.equal(supply.projectSupplyFor, project.project.id);
    s.controller.complete(supply.id, supply.generation, false, 'No materials found');
    assert.equal(s.controller.claim(), null);
    const build = s.controller.records.find(t => t.projectId === project.project.id);
    assert.equal(build.dependsOnTask, supply.id); assert.equal(build.state, 'queued');
    assert.match(supply.task, /60 cobblestone/);
    assert.equal(s.controller.projectManager.request({action:'supplies',requester:'Alice',identifier:project.project.id,key:'supplies'}).message, supplied.message);
});

test('cancelling during a committed placement cannot trigger a second placement after resume', async () => {
    const s = scene(); const project = s.create(line(2));
    const placed = s.bot.placeBlock.bind(s.bot);
    let interrupted = false;
    s.bot.placeBlock = async (...args) => {
        await placed(...args);
        if (!interrupted) { interrupted = true; await s.controller.control('pause', 'Alice'); }
    };
    await assert.rejects(s.batch(project), /stopped or paused/);
    assert.equal(s.bot.placed.length, 1);
    await s.controller.control('resume', 'Alice');
    const finished = await s.batch(project);
    assert.equal(finished.project.state, 'completed');
    assert.equal(s.bot.placed.length, 2);
    assert.equal(s.stacks[0].count, 298);
});

test('unconfirmed placement is preserved for review and explicit plan-only revision does not restart work', async () => {
    const s = scene(); const project = s.create(line(1));
    s.bot.placeBlock = async () => {}; // No observed world change.
    const blocked = await s.batch(project);
    assert.equal(blocked.blocked, true);
    assert.equal(s.controller.projects[0].progress['4,64,4'].status, 'uncertain');
    const again = await s.batch(project);
    assert.equal(again.project.state, 'conflict');
    await s.controller.control('pause', 'Alice');
    s.controller.projectManager.request({ action:'revise',identifier:project.project.id,name:'wall',requester:'Alice',
        origin:{type:'coordinates',position:{x:4,y:64,z:4}}, blocks:line(2),execute:false });
    assert.equal(s.controller.active(), undefined);
    assert.equal(s.controller.projects[0].status, 'planned');
});

test('a large project is bounded to 128 cells per batch and verifies dependencies before attached cells', async () => {
    const s = scene(); const blocks = [];
    for (let z = 0; z < 3; z++) for (let x = 0; x < 50; x++) blocks.push({ name:'cobblestone',position:{x,y:0,z} });
    const project = s.create(blocks);
    const first = await s.batch(project);
    assert.equal(first.inspected, 128); assert.equal(first.project.remaining, 22);
    const second = await s.batch(project);
    assert.equal(second.project.state, 'completed'); assert.equal(s.bot.placed.length, 150);
    const attached = scene();
    const plan = attached.create([{name:'cobblestone',position:{x:0,y:1,z:0},dependsOn:[{x:0,y:0,z:0}]},line(1)[0]]);
    await attached.batch(plan);
    assert.deepEqual(attached.bot.placed, ['(4, 64, 4)','(4, 65, 4)']);
});

test('queue-capacity failures do not leave an unacknowledged created build, and explicit continuation can bypass failed supplies', () => {
    const full = scene();
    for (let i=0;i<20;i++) full.controller.enqueue({task:`Other ${i}`,requester:'Alice'});
    assert.throws(() => full.create(line(1)), /queue is full/);
    assert.equal(full.controller.projects.length, 0);
    const planned = full.create(line(1), {execute:false});
    assert.equal(full.controller.projectManager.request({action:'supplies',requester:'Alice',identifier:planned.project.id}).ok, true);
    const s = scene({stacks:[]}); const project = s.create(line(1), {execute:false});
    s.controller.projectManager.request({action:'supplies',requester:'Alice',identifier:project.project.id});
    const supply = s.controller.claim(); s.controller.complete(supply.id, supply.generation, false);
    assert.equal(s.controller.projectManager.summary(s.controller.projects[0]).state, 'waiting_for_supplies');
    s.stacks.push({name:'cobblestone',count:1,type:registry.itemsByName.cobblestone.id});
    s.controller.projectManager.request({action:'continue',requester:'Alice',identifier:project.project.id});
    assert.equal(s.controller.claim().projectId, project.project.id);
});

test('a public project cannot publish a revision supplied privately and multipart edits are rejected', () => {
    const s = scene(); const project = s.create(line(1), {execute:false});
    assert.throws(() => s.controller.projectManager.request({action:'revise',identifier:project.project.id,name:'wall',requester:'Alice',recipient:'Alice',
        origin:{type:'coordinates',position:{x:4,y:64,z:4}},blocks:line(2)}), /public project in public chat/);
    assert.equal(s.controller.projects[0].versions.length, 1);
    assert.throws(() => s.create([{name:'oak_door',position:{x:0,y:0,z:0}}], {name:'door'}), /Multi-cell/);
});
