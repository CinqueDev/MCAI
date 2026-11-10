async function navigateToGoal(bot, goal, timeoutMs = 30000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        throw new Error("Navigation timeout must be 1-120000 milliseconds");
    }
    const previous = bot.pathfinder.movements;
    const movements = new Movements(bot);
    // Visiting players must not tunnel through their houses or build scaffolding.
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowFreeMotion = false;
    movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    let timer;
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    bot.pathfinder.setGoal(null);
                    bot.clearControlStates();
                    reject(new Error("Navigation timed out; destination was not reached"));
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        bot.pathfinder.setGoal(null);
        if (previous) bot.pathfinder.setMovements(previous);
    }
}

async function moveToPosition(bot, position, range = 1, timeoutMs = 30000) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite) ||
        Math.abs(position.x) > 29999984 || Math.abs(position.z) > 29999984) {
        throw new Error("Provide finite Minecraft coordinates {x, y, z}");
    }
    if (!Number.isFinite(range) || range < 0 || range > 4) {
        throw new Error("Arrival range must be between 0 and 4 blocks");
    }
    if (Number.isFinite(bot.game?.minY) && Number.isFinite(bot.game?.height) &&
        (position.y < bot.game.minY || position.y >= bot.game.minY + bot.game.height)) {
        throw new Error("Destination is outside this dimension's build height");
    }
    const goal = new GoalNear(position.x, position.y, position.z, range);
    await navigateToGoal(bot, goal, timeoutMs);
    if (!goal.isEnd(bot.entity.position.floored())) {
        throw new Error("Navigation ended without reaching the destination");
    }
    bot.checkTask?.();
    const result = { type: "move", destination: { x: position.x, y: position.y, z: position.z },
        range, position: bot.entity.position.clone(), verified: true };
    (bot.actionResults ||= []).push(result);
    return result;
}
