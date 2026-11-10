async function moveToPlayer(bot, username, range = 2, timeoutMs = 30000) {
    if (typeof username !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(username)) {
        throw new Error("Provide the player's actual Minecraft username");
    }
    if (!Number.isFinite(range) || range < 1 || range > 4) throw new Error("Player range must be 1-4 blocks");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid navigation timeout");
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < 3; attempt++) {
        const player = Object.values(bot.players).find(p => p.username?.toLowerCase() === username.toLowerCase());
        if (!player?.entity?.position || player.entity.isValid === false) {
            throw new Error(`${username} is not visible in loaded chunks. Ask for x, y, z coordinates and dimension; do not guess.`);
        }
        const entity = player.entity;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out reaching ${username}`);
        await navigateToGoal(bot, new GoalFollow(entity, range), remaining);
        const current = player.entity;
        if (current && current.isValid !== false && bot.entity.position.distanceTo(current.position) <= range + 0.75) {
            await bot.lookAt(current.position.offset(0, 1.4, 0));
            const result = { type: "approach_player", player: player.username,
                position: bot.entity.position.clone(), target: current.position.clone(), range, verified: true };
            (bot.actionResults ||= []).push(result);
            return result;
        }
    }
    throw new Error(`${username} kept moving or disappeared; ask them to wait or provide coordinates`);
}
