async function moveToPlayer(bot, username, range = 2, timeoutMs = 30000) {
    if (typeof username !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(username)) {
        throw new Error("Provide the player's actual Minecraft username");
    }
    if (!Number.isFinite(range) || range < 1 || range > 4) throw new Error("Player range must be 1-4 blocks");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid navigation timeout");
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < 3; attempt++) {
        const target = bot.resolveTarget?.({ type: 'player', name: username });
        const entry = Object.entries(bot.players || {}).find(([name, p]) => (p.username || name).toLowerCase() === username.toLowerCase());
        const entity = (entry?.[1]?.entity?.isValid !== false && entry?.[1]?.entity?.position ? entry[1].entity : null) ||
            Object.values(bot.entities || {}).find(e => e.isValid !== false && e.position && e.username?.toLowerCase() === username.toLowerCase());
        if (!entity || (target && target.status !== 'resolved')) {
            throw new Error(`${username} is not visible in loaded chunks. Ask for x, y, z coordinates and dimension; do not guess.`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out reaching ${username}`);
        await navigateToGoal(bot, new GoalFollow(entity, range), remaining);
        const current = entry?.[1]?.entity || Object.values(bot.entities || {}).find(e => e.id === entity.id) || entity;
        if (current && current.isValid !== false && bot.entity.position.distanceTo(current.position) <= range + 0.75) {
            await bot.lookAt(current.position.offset(0, 1.4, 0));
            bot.checkTask?.();
    const result = { type: "approach_player", player: entity.username || entry?.[0] || username,
                position: bot.entity.position.clone(), target: current.position.clone(), range, verified: true };
            (bot.actionResults ||= []).push(result);
            return result;
        }
    }
    throw new Error(`${username} kept moving or disappeared; ask them to wait or provide coordinates`);
}
