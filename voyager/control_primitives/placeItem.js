async function placeItem(bot, name, position) {
    if (typeof name !== "string" || !mcData.itemsByName[name] || !mcData.blocksByName[name]) {
        throw new Error(`Unknown placeable block: ${name}`);
    }
    if (!position || ![position.x, position.y, position.z].every(Number.isInteger)) {
        throw new Error("Block position must contain integer x, y, z coordinates");
    }
    position = new Vec3(position.x, position.y, position.z);
    // Load the destination before inspecting it. Never overwrite another block.
    await moveToPosition(bot, position, 3);
    const existing = bot.blockAt(position);
    if (!existing) throw new Error("Destination chunk is not loaded");
    if (existing.name === name) {
        bot.checkTask?.();
    const result = { type: "place", block: name, position, alreadyPresent: true, verified: true };
        (bot.actionResults ||= []).push(result);
        return result;
    }
    if (!["air", "cave_air", "void_air"].includes(existing.name)) {
        throw new Error(`Cannot place ${name}: ${existing.name} already occupies ${position}`);
    }
    const item = bot.inventory.items().find(item => item.name === name);
    if (!item) throw new Error(`No ${name} in inventory`);
    const vectors = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)];
    let reference, face;
    for (const vector of vectors) {
        const block = bot.blockAt(position.minus(vector));
        if (block && block.boundingBox === "block") {
            reference = block;
            face = vector;
            break;
        }
    }
    if (!reference) throw new Error(`No solid support for ${name} at ${position}; build supports first`);
    await navigateToGoal(bot, new GoalPlaceBlock(position, bot.world, { faces: [face.scaled(-1)] }));
    // Recheck after moving: another player could have occupied this cell.
    if (!["air", "cave_air", "void_air"].includes(bot.blockAt(position)?.name)) {
        throw new Error("Placement destination changed while approaching");
    }
    await bot.equip(item, "hand");
    // Sneaking avoids opening a supporting chest/workstation instead of placing.
    const sneaking = bot.getControlState("sneak");
    try {
        bot.setControlState("sneak", true);
        await bot.placeBlock(reference, face);
    } finally {
        bot.setControlState("sneak", sneaking);
    }
    if (bot.blockAt(position)?.name !== name) throw new Error(`Placement of ${name} at ${position} was not confirmed`);
    bot.checkTask?.();
    const result = { type: "place", block: name, position, alreadyPresent: false, verified: true };
    (bot.actionResults ||= []).push(result);
    bot.save(`${name}_placed`);
    return result;
}
