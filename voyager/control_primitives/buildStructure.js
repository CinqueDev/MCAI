async function buildStructure(bot, blocks) {
    if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 128) {
        throw new Error("A build batch must contain 1-128 blocks: {name, position: {x, y, z}}");
    }
    const cells = new Set();
    const needed = {};
    for (const block of blocks) {
        if (!block || !mcData.blocksByName[block.name] || !mcData.itemsByName[block.name] ||
            !block.position || ![block.position.x, block.position.y, block.position.z].every(Number.isInteger)) {
            throw new Error("Invalid blueprint block; use a block item name and integer coordinates");
        }
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        if (cells.has(key)) throw new Error(`Duplicate blueprint cell: ${key}`);
        cells.add(key);
        const existing = bot.blockAt(new Vec3(block.position.x, block.position.y, block.position.z));
        if (existing && existing.name === block.name) continue;
        if (existing && !["air", "cave_air", "void_air"].includes(existing.name)) {
            throw new Error(`Build would overwrite ${existing.name} at ${key}`);
        }
        needed[block.name] = (needed[block.name] || 0) + 1;
    }
    for (const [name, count] of Object.entries(needed)) {
        const available = bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
        if (available < count) throw new Error(`Build needs ${count} ${name}; only ${available} available. Gather materials first.`);
    }
    // Supply a ground-up blueprint, supports before attached blocks. No implicit clearing.
    for (const block of blocks) await placeItem(bot, block.name, block.position);
    for (const block of blocks) {
        const position = new Vec3(block.position.x, block.position.y, block.position.z);
        if (bot.blockAt(position)?.name !== block.name) throw new Error(`Build verification failed at ${position}`);
    }
    const result = { type: "build", blocks: blocks.length,
        blueprint: blocks.map(b => ({ name: b.name, position: { ...b.position } })), verified: true };
    (bot.actionResults ||= []).push(result);
    return result;
}
