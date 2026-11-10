// Place one inventory block at exact integer world coordinates (Vec3 or {x,y,z}).
// Walks into reach, checks solid support, equips the item, places, and verifies the world block.
// Throws if material/support is missing, destination is occupied/unloaded, path fails, or placement fails.
// A matching block already there counts as success without consuming inventory (safe to resume).
// Does not clear blocks, invent materials, or restore workstations after placement.
async function placeItem(bot, name, position) {}
