async function waitForItem(bot, names, count = 1, timeoutMs = 30000) {
    names = typeof names === "string" ? [names] : names;
    if (!Array.isArray(names) || !names.length || names.some(name => !mcData.itemsByName[name])) {
        throw new Error("Provide an item name or an array of acceptable item names");
    }
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        throw new Error("Use a positive item count and a timeout of 1-120000 milliseconds");
    }
    const total = () => bot.inventory.items().filter(item => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    const before = total();
    const deadline = Date.now() + timeoutMs;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    while (Date.now() < deadline) {
        const received = total() - before;
        if (received >= count) {
            const result = { type: "receive", items: [...names], count: received, verified: true };
            (bot.actionResults ||= []).push(result);
            return result;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    throw new Error(`Waited for ${names.join(" or ")}, but no sufficient inventory increase was observed`);
}
