async function stayAt(bot, reference = null) {
    bot.checkTask?.();
    if (!bot.movementModes) throw new Error('Persistent movement is unavailable');
    return bot.movementModes.assign('stay', reference);
}
