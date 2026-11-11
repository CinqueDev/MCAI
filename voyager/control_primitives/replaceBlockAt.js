async function replaceBlockAt(bot, position, expected, name, state = {}) {
    bot.checkTask?.();
    if (typeof expected !== 'string' || !mcData.blocksByName[expected]) throw new Error('Replacement requires the exact expected original block name');
    if (!bot.blockStates) throw new Error('Block-state validation is unavailable');
    bot.blockStates.position(position, bot.game);
    if (!mcData.blocksByName[name] || !mcData.itemsByName[name]) throw new Error('Replacement requires a valid placeable inventory block');
    bot.blockStates.validate(mcData, name, state);
    await moveToPosition(bot, position, 3);
    const target = new Vec3(position.x, position.y, position.z);
    const current = bot.blockAt(target);
    if (bot.blockStates.matches(current, name, state)) {
        const result = { type: 'replace', block: name, state, position: target, alreadyPresent: true, observedAt: Date.now() / 1000, verified: true };
        (bot.actionResults ||= []).push(result);
        return result;
    }
    if (!current || current.name !== expected) throw new Error(`Replacement conflict: expected ${expected}; the cell is preserved`);
    if (!bot.inventory.items().some(i => i.name === name && i.count > 0)) throw new Error(`No ${name} available; nothing was removed`);
    await removeBlockAt(bot, position, expected);
    try {
        await placeItem(bot, name, position, state);
    } catch (error) {
        (bot.actionResults ||= []).push({ type: 'replace', position: target, removed: expected,
            placed: false, verified: false, error: error.message, observedAt: Date.now() / 1000 });
        throw new Error(`Removed ${expected}, but replacement was not confirmed: ${error.message}`);
    }
    const result = { type: 'replace', position: target, removed: expected, block: name, state, observedAt: Date.now() / 1000, verified: true };
    (bot.actionResults ||= []).push(result);
    return result;
}
