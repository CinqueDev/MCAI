function resolveTarget(bot, reference) {
    bot.checkTask?.();
    if (!bot.resolveTarget) throw new Error('World target resolver is unavailable');
    return bot.resolveTarget(reference);
}

async function moveToTarget(bot, reference, range = 1, timeoutMs = 30000) {
    const target = resolveTarget(bot, reference);
    if (target.status !== 'resolved') throw new Error(target.reason);
    return target.kind === 'player' ? moveToPlayer(bot, target.player, Math.max(1, range), timeoutMs)
        : moveToPosition(bot, target.position, range, timeoutMs);
}
