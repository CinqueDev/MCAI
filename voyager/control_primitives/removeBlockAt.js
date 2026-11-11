async function removeBlockAt(bot, position, expected = null) {
    bot.checkTask?.();
    if (!position || ![position.x, position.y, position.z].every(Number.isInteger)) throw new Error('Removal needs exact integer coordinates');
    const target = new Vec3(position.x, position.y, position.z);
    await moveToPosition(bot, target, 3);
    let block = bot.blockAt(target);
    if (!block) throw new Error('Removal target is not loaded');
    const air = ['air', 'cave_air', 'void_air'];
    if (air.includes(block.name)) {
        const result = { type: 'remove', position: target, alreadyAbsent: true, observedAt: Date.now() / 1000, verified: true };
        (bot.actionResults ||= []).push(result);
        return result;
    }
    if (expected && block.name !== expected) throw new Error(`Removal conflict: expected ${expected}, found ${block.name}; nothing was removed`);
    if (bot.blockStates?.multipart(mcData, block.name)) throw new Error('This block spans multiple cells; exact single-cell removal is unsupported');
    const original = { name: block.name, stateId: block.stateId };
    if (!block.diggable) throw new Error(`${block.name} cannot be broken`);
    if (bot.tool?.equipForBlock) await bot.tool.equipForBlock(block);
    if (block.canHarvest && !block.canHarvest(bot.heldItem?.type)) throw new Error(`An appropriate harvesting tool is required for ${block.name}`);
    if (!bot.canDigBlock?.(block)) throw new Error('Cannot reach or dig that exact block');
    bot.checkTask?.();
    block = bot.blockAt(target);
    if (!block || block.name !== original.name || block.stateId !== original.stateId) throw new Error('Removal target changed while approaching/equipping; nothing was removed');
    let timer;
    try {
        await Promise.race([bot.dig(block, true), new Promise((_, reject) => {
            timer = setTimeout(() => {
                try { Promise.resolve(bot.stopDigging?.()).catch(() => {}); } catch (_) {}
                reject(new Error('Exact block removal timed out'));
            }, 60000);
        })]);
    } finally { clearTimeout(timer); }
    bot.checkTask?.();
    if (!air.includes(bot.blockAt(target)?.name)) throw new Error(`Removal at ${target} was not confirmed`);
    const result = { type: 'remove', block: original.name, position: target, observedAt: Date.now() / 1000, verified: true };
    (bot.actionResults ||= []).push(result);
    return result;
}
