async function buildProjectBatch(bot, projectId, limit = 128) {
    if (!bot.projectManager) throw new Error('Persistent projects are unavailable');
    return bot.projectManager.runBatch(projectId, {
        move: position => moveToPosition(bot, position, 3),
        remove: (position, expected) => removeBlockAt(bot, position, expected),
        place: (name, position, state) => placeItem(bot, name, position, state),
    }, limit);
}
