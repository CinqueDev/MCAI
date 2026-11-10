async function giveItemToPlayer(bot, username, name, count = 1) {
    if (!Number.isInteger(count) || count < 1) throw new Error("Give count must be a positive integer");
    if (!mcData.itemsByName[name]) throw new Error(`Unknown item: ${name}`);
    const available = bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    if (available < count) throw new Error(`Need ${count} ${name}, but only have ${available}`);
    await moveToPlayer(bot, username, 2);
    const player = Object.values(bot.players).find(p => p.username?.toLowerCase() === username.toLowerCase());
    if (!player?.entity || bot.entity.position.distanceTo(player.entity.position) > 2.75) {
        throw new Error("Player moved out of reach; nothing was dropped");
    }
    await bot.lookAt(player.entity.position.offset(0, 1, 0));
    const dropped = await dropItem(bot, name, count);
    bot.checkTask?.();
    const result = { ...dropped, type: "give", player: player.username, pickupConfirmed: false };
    (bot.actionResults ||= []).push(result);
    return result; // Verified drop near the player, not proof they picked it up.
}
