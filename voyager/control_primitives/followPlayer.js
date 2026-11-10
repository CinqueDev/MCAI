async function followPlayer(bot, username, distance = 2) {
    bot.checkTask?.();
    if (!bot.movementModes) throw new Error('Persistent movement is unavailable');
    return bot.movementModes.assign('follow', { type: 'player', name: username }, distance);
}
