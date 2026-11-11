async function placeItem(bot, name, position, state = {}) {
    if (typeof name !== "string" || !mcData.itemsByName[name] || !mcData.blocksByName[name]) {
        throw new Error(`Unknown placeable block: ${name}`);
    }
    if (!position || ![position.x, position.y, position.z].every(Number.isInteger)) {
        throw new Error("Block position must contain integer x, y, z coordinates");
    }
    if (Object.keys(state).length && !bot.blockStates) throw new Error("Block-state placement is unavailable");
    bot.blockStates?.position(position, bot.game);
    bot.blockStates?.validate(mcData, name, state);
    const matching = block => bot.blockStates ? bot.blockStates.matches(block, name, state) : block?.name === name;
    position = new Vec3(position.x, position.y, position.z);
    // Load the destination before inspecting it. Never overwrite another block.
    await moveToPosition(bot, position, 3);
    const existing = bot.blockAt(position);
    if (!existing) throw new Error("Destination chunk is not loaded");
    if (matching(existing)) {
        bot.checkTask?.();
    const result = { type: "place", block: name, state: { ...state }, position, alreadyPresent: true, observedAt: Date.now() / 1000, verified: true };
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
        if (state.axis && !vector[state.axis]) continue;
        if (state.type === "top" && vector.y > 0) continue;
        if (state.type === "bottom" && vector.y < 0) continue;
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
        if (Object.keys(state).length) {
            const options = { swingArm: "right" };
            if (state.type) options.half = state.type;
            if (state.facing) {
                const yaw = { north: Math.PI, south: 0, east: Math.PI / 2, west: -Math.PI / 2 }[state.facing];
                await bot.look(yaw, 0, true);
                options.forceLook = "ignore";
            }
            bot.checkTask?.();
            await bot._placeBlockWithOptions(reference, face, options);
        } else await bot.placeBlock(reference, face);
    } finally {
        bot.setControlState("sneak", sneaking);
    }
    if (!matching(bot.blockAt(position))) throw new Error(`Placement/state of ${name} at ${position} was not confirmed; the placed block is preserved for review`);
    bot.checkTask?.();
    const result = { type: "place", block: name, state: { ...state }, position, alreadyPresent: false, observedAt: Date.now() / 1000, verified: true };
    (bot.actionResults ||= []).push(result);
    bot.save(`${name}_placed`);
    return result;
}
