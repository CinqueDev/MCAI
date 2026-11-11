const AIR = new Set(['air', 'cave_air', 'void_air']);
const FACING = new Set(['furnace', 'blast_furnace', 'smoker', 'chest', 'ender_chest']);
function validate(registry, name, state = {}) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Block state must be an object');
    for (const [key, value] of Object.entries(state)) {
        const definition = registry.blocksByName[name]?.states?.find(s => s.name === key);
        const supported = (key === 'axis' && ['x', 'y', 'z'].includes(value)) ||
            (key === 'type' && name.endsWith('_slab') && ['top', 'bottom'].includes(value)) ||
            (key === 'facing' && FACING.has(name) && ['north', 'south', 'east', 'west'].includes(value));
        if (!supported || !definition?.values?.includes(value)) throw new Error(`Unsupported placement state ${name}.${key}=${value}; supported: axis, single slab type, horizontal furnace/chest facing`);
    }
}
function multipart(registry, name) {
    return !!registry.blocksByName[name]?.states?.some(s =>
        (s.name === 'half' && s.values?.includes('upper')) || (s.name === 'part' && s.values?.includes('head')));
}
function matches(block, name, state = {}) {
    if (!block || block.name !== name) return false;
    const actual = block.getProperties?.() || {};
    return Object.entries(state).every(([key, value]) => actual[key] === value);
}
function position(p, game = {}) {
    if (!p || ![p.x, p.y, p.z].every(Number.isInteger) || Math.abs(p.x) > 29999984 || Math.abs(p.z) > 29999984 ||
        (Number.isFinite(game.minY) && Number.isFinite(game.height) && (p.y < game.minY || p.y >= game.minY + game.height)))
        throw new Error('Provide integer coordinates inside this dimension');
    return { x: p.x, y: p.y, z: p.z };
}
function fingerprint(block) { return block ? { name: block.name, stateId: block.stateId } : null; }
function same(block, saved) { return !!block && !!saved && block.name === saved.name && block.stateId === saved.stateId; }
module.exports = { AIR, validate, multipart, matches, position, fingerprint, same };
