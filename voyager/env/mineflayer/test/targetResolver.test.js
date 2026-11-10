const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { resolveWorldTarget } = require('../lib/targetResolver');

function scene() {
    const player = { username: 'Alice', type: 'player', id: 1, position: new Vec3(5, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.62 };
    const bot = { username: 'Voyager', game: { dimension: 'overworld', minY: -64, height: 384 }, entity: { position: new Vec3(0, 64, 0) }, players: { Alice: {} }, entities: { 1: player },
        blockAt: p => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }) };
    return { bot, player, resolve: (ref, opts = {}) => resolveWorldTarget(bot, ref, { requester: 'Alice', ...opts }) };
}

test('player, here and behind references use loaded/request-time data and never tab-list guesses', () => {
    const { bot, player, resolve } = scene();
    assert.equal(resolve({ type: 'player', name: 'me' }).player, 'Alice');
    assert.equal(resolve({ type: 'behind_player' }).position.z, 2);
    const captured = resolve({ type: 'current_location' }, { requesterLocation: { x: 1, y: 70, z: 3 }, requesterDimension: 'overworld' });
    assert.deepEqual(captured.position, { x: 1, y: 70, z: 3 });
    player.isValid = false;
    assert.equal(resolve({ type: 'player', name: 'Alice' }).status, 'unresolved');
    assert.equal(resolve({ type: 'current_location' }).status, 'unresolved');
    assert.equal(resolve({ type: 'coordinates', position: { x: 2, y: 70, z: 3 }, dimension: 'the_nether' }).status, 'unresolved');
    bot.game.dimension = 'minecraft:overworld';
    assert.equal(resolve({ type: 'coordinates', position: { x: 2, y: 70, z: 3 }, dimension: 'overworld' }).status, 'resolved');
});

test('pointed blocks return the observed face, reject missing head data and cannot raycast across unknown chunks', () => {
    const { bot, player, resolve } = scene();
    let ray;
    bot.world = { raycast: (start, direction, range) => {
        ray = { start, direction, range };
        return { position: new Vec3(5, 65, -3), name: 'chest', face: 3, intersect: new Vec3(5, 65.62, -2) };
    } };
    const target = resolve({ type: 'looked_block' });
    assert.equal(target.block, 'chest');
    assert.equal(target.face, 3);
    assert.equal(ray.range, 6);
    assert.equal(ray.direction.z, -1);
    assert.equal(ray.start.y, 65.62);
    bot.blockAt = () => null;
    assert.equal(resolve({ type: 'looked_block' }).status, 'unresolved');
    delete player.eyeHeight;
    assert.match(resolve({ type: 'looked_block' }).reason, /direction\/eye/);
});

test('beside references require supported space; multiple entities and landmarks need clarification', () => {
    const { bot, resolve } = scene();
    const adjacent = resolve({ type: 'beside_block', position: { x: 4, y: 64, z: 0 } });
    assert.equal(adjacent.status, 'resolved');
    assert.equal(adjacent.position.x, 3);
    bot.blockAt = () => null;
    assert.equal(resolve({ type: 'beside_block', position: { x: 4, y: 64, z: 0 } }).status, 'unresolved');
    bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(0, 64, 5) };
    bot.entities[3] = { id: 3, name: 'zombie', position: new Vec3(0, 64, 6) };
    assert.equal(resolve({ type: 'entity', name: 'zombie' }).status, 'ambiguous');
    assert.equal(resolve({ type: 'entity', entityId: 2 }).entityId, 2);
    const memory = { id: 'home', name: 'home', kind: 'place', dimension: 'overworld', stale: false,
        source: 'reported', verification: 'unverified', data: { position: { x: 10, y: 64, z: 10 } } };
    assert.equal(resolve({ type: 'landmark', name: 'home' }, { memories: [memory] }).status, 'resolved');
    assert.equal(resolve({ type: 'landmark', name: 'home' }, { memories: [memory, { ...memory, id: 'other' }] }).status, 'ambiguous');
    assert.equal(resolve({ type: 'landmark', name: 'home' }, { memories: [{ ...memory, stale: true }] }).status, 'unresolved');
    assert.equal(resolve({ type: 'landmark', name: 'home' }, { memories: [{ ...memory, dimension: 'the_nether' }] }).status, 'unresolved');
    assert.equal(resolve({ type: 'landmark', name: 'home' }).status, 'unresolved');
});
