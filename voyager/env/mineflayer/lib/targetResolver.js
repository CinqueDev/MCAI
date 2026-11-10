const { Vec3 } = require('vec3');
const { playerEntity } = require('./playerState');

const dimension = value => String(value || '').replace(/^minecraft:/, '').replace(/^the_/, '');
const coordinates = p => p && [p.x, p.y, p.z].every(Number.isFinite) && Math.abs(p.x) <= 29999984 && Math.abs(p.z) <= 29999984;
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const unresolved = reason => ({ status: 'unresolved', reason });

function resolveWorldTarget(bot, reference, { requester, memories = [], requesterLocation = null, requesterDimension = null } = {}) {
    if (!reference || typeof reference !== 'object') return unresolved('Specify a target reference.');
    const current = bot.game?.dimension;
    const resolved = (kind, p, extra = {}, dim = current) => {
        if (!coordinates(p)) return unresolved('The target has no valid coordinates.');
        if (!dim || !current || dimension(dim) !== dimension(current)) return unresolved('Target dimension is unknown or different; portal travel is not supported.');
        if (Number.isFinite(bot.game?.minY) && Number.isFinite(bot.game?.height) &&
            (p.y < bot.game.minY || p.y >= bot.game.minY + bot.game.height)) return unresolved('Target is outside this dimension\'s build height.');
        return { status: 'resolved', kind, position: plain(p), dimension: dim, ...extra };
    };
    const getPlayer = name => playerEntity(bot, !name || /^(me|myself)$/i.test(name) ? requester : name);
    const pointedBlock = name => {
        const player = getPlayer(name);
        if (!player || !coordinates(player.position) || !Number.isFinite(player.pitch) || !Number.isFinite(player.headYaw ?? player.yaw) || !Number.isFinite(player.eyeHeight))
            return unresolved('Your loaded head direction/eye position is unavailable. Provide block coordinates.');
        if (!bot.world?.raycast || !bot.blockAt) return unresolved('Pointing information is unavailable. Provide coordinates.');
        const yaw = player.headYaw ?? player.yaw, pitch = player.pitch;
        const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
        const start = new Vec3(player.position.x, player.position.y + player.eyeHeight, player.position.z);
        const hit = bot.world.raycast(start, direction, 6);
        const distance = hit?.intersect ? start.distanceTo(hit.intersect) : hit ? Math.min(6, start.distanceTo(hit.position) + 1) : 6;
        for (let step = 0; step < distance; step += 0.25) {
            if (!bot.blockAt(start.plus(direction.scaled(step)))) return unresolved('The pointed path crosses unloaded chunks. Provide coordinates.');
        }
        return hit ? resolved('block', hit.position, { block: hit.name, face: hit.face, evidence: 'loaded player head raycast', player: player.username || requester })
            : unresolved('No pointed-at block within 6 blocks. Provide coordinates or point at a closer block.');
    };
    const adjacent = target => {
        if (target.status !== 'resolved') return target;
        const p = new Vec3(target.position.x, target.position.y, target.position.z).floored();
        const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => p.offset(x, 0, z));
        const safe = candidates.filter(foot => {
            const feet = bot.blockAt?.(foot), head = bot.blockAt?.(foot.offset(0, 1, 0)), floor = bot.blockAt?.(foot.offset(0, -1, 0));
            return feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' && floor?.boundingBox === 'block' &&
                ![feet, head, floor].some(b => /lava|fire|cactus|magma|campfire/.test(b.name));
        });
        safe.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
        return safe.length ? resolved('coordinates', safe[0], { beside: target.position, block: target.block })
            : unresolved('No loaded, supported space beside that block. Specify a standing position.');
    };
    switch (reference.type) {
        case 'player': {
            const player = getPlayer(reference.name);
            return player && coordinates(player.position) ? resolved('player', player.position, { player: player.username || reference.name || requester, entityId: player.id })
                : unresolved('That player is not visible in loaded chunks. Ask for coordinates and dimension; do not guess.');
        }
        case 'current_location': {
            const player = getPlayer(requester);
            return requesterLocation ? resolved('coordinates', requesterLocation, { player: requester, evidence: 'request-time player coordinates' }, requesterDimension)
                : player ? resolved('coordinates', player.position, { player: requester }) : unresolved('Your loaded position is unknown. Provide coordinates and dimension.');
        }
        case 'coordinates':
        case 'block':
            if (reference.type === 'block' && (!coordinates(reference.position) || !Object.values(reference.position).every(Number.isInteger))) return unresolved('Block coordinates must be integers.');
            return resolved(reference.type, reference.position, {}, reference.dimension || current);
        case 'behind_player': {
            const player = getPlayer(reference.name);
            if (!player || !coordinates(player.position) || !Number.isFinite(player.headYaw ?? player.yaw)) return unresolved('Player position/direction is unavailable. Provide a standing position.');
            const yaw = player.headYaw ?? player.yaw;
            const p = new Vec3(player.position.x + Math.sin(yaw) * 2, player.position.y, player.position.z + Math.cos(yaw) * 2).floored();
            const feet = bot.blockAt?.(p), head = bot.blockAt?.(p.offset(0, 1, 0)), floor = bot.blockAt?.(p.offset(0, -1, 0));
            if (feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty' || floor?.boundingBox !== 'block' || [feet, head, floor].some(b => /lava|fire|cactus|magma|campfire/.test(b.name))) return unresolved('The space behind the player is blocked, hazardous or unloaded. Specify another position.');
            return resolved('coordinates', p, { player: player.username || requester, relation: 'behind' });
        }
        case 'looked_block': return pointedBlock(reference.name);
        case 'beside_block': {
            const target = reference.position ? resolved('block', reference.position, {}, reference.dimension || current) : pointedBlock(reference.name);
            if (reference.block && target.block !== reference.block) return unresolved(`The pointed block is not ${reference.block}. Provide its coordinates.`);
            return adjacent(target);
        }
        case 'entity': {
            const found = Object.values(bot.entities || {}).filter(e => e.isValid !== false && coordinates(e.position) &&
                (reference.entityId != null ? e.id === reference.entityId : e.name === reference.name));
            if (found.length !== 1) return { status: found.length ? 'ambiguous' : 'unresolved', reason: 'Specify one currently loaded entity by ID or a clearer reference.' };
            return resolved('entity', found[0].position, { entityId: found[0].id, entity: found[0].name });
        }
        case 'landmark': {
            const name = String(reference.name || '').trim().toLowerCase();
            const matches = memories.filter(m => m.name?.toLowerCase() === name && ['place', 'resource', 'storage', 'project'].includes(m.kind) && m.validity !== 'invalidated' && (!reference.dimension || dimension(m.dimension) === dimension(reference.dimension)));
            if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'unresolved', reason: 'Name a unique remembered place, including its dimension if needed.' };
            const memory = matches[0];
            if (memory.stale || (memory.expires_at != null && memory.expires_at <= Date.now() / 1000) || memory.source === 'legacy') return unresolved('That remembered location is stale; confirm its coordinates before using it.');
            const support = memory.data?.position ? memory : memories.find(m => memory.related_ids?.includes(m.id) && m.data?.position);
            if (!support || support.stale || support.validity === 'invalidated' || (support.expires_at != null && support.expires_at <= Date.now() / 1000))
                return unresolved('The supporting location observation is unavailable or stale. Confirm its coordinates.');
            return resolved('landmark', support.data.position, { memoryId: memory.id, source: memory.source, verification: support.verification }, memory.dimension || support.dimension);
        }
        default: return unresolved('Unsupported target type. Provide a player, coordinate, pointed block, or remembered place.');
    }
}
module.exports = { resolveWorldTarget, coordinates, dimension };
