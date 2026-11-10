async function dropItem(bot, name, count = 1) {
    if (typeof name !== "string" || !mcData.itemsByName[name]) throw new Error(`Unknown item: ${name}`);
    if (!Number.isInteger(count) || count < 1) throw new Error("Drop count must be a positive integer");
    const stacks = bot.inventory.items().filter(item => item.name === name);
    const before = stacks.reduce((total, item) => total + item.count, 0);
    if (before < count) throw new Error(`Need ${count} ${name}, but only have ${before}; nothing was dropped`);
    let remaining = count;
    let failure;
    try {
        for (const stack of stacks) {
            const amount = Math.min(remaining, stack.count);
            await bot.toss(stack.type, stack.metadata, amount);
            remaining -= amount;
            if (remaining === 0) break;
        }
    } catch (error) {
        failure = error;
    }
    const after = bot.inventory.items().filter(item => item.name === name).reduce((total, item) => total + item.count, 0);
    if (failure || before - after !== count) {
        (bot.actionResults ||= []).push({ type: "drop", item: name, requested: count,
            observedInventoryDecrease: before - after, before, after, verified: false });
        throw new Error(`Drop incomplete or unconfirmed: inventory decreased by ${before - after} of ${count} ${name}. Inspect this attempt before dropping any remaining items. ${failure?.message || ""}`);
    }
    const result = { type: "drop", item: name, count, before, after,
        position: bot.entity.position.clone(), verified: true };
    (bot.actionResults ||= []).push(result);
    return result;
}
