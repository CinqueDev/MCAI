// Only loaded entities have trustworthy current coordinates. Tab-list presence is not location.
function playerState(bot) {
    const players = { ...(bot.players || {}) };
    // Loaded player entities can exist before (or without) their tab-list entry.
    for (const entity of Object.values(bot.entities || {})) {
        const name = entity.username || bot.uuidToUsername?.[entity.uuid];
        if (entity.isValid !== false && /^[A-Za-z0-9_]{1,16}$/.test(name || "") &&
            (entity.type === "player" || entity.name === "player" || entity.username)) {
            if (!players[name]) players[name] = { username: name, uuid: entity.uuid, entity };
        }
    }
    return Object.entries(players)
        .filter(([name]) => name.toLowerCase() !== bot.username?.toLowerCase())
        .map(([name, player]) => {
            // Modern protocol updates can populate the entity cache before binding
            // the tab-list entry. Both sources must describe a currently loaded player.
            const matchingEntity = (entity) =>
                entity &&
                entity.isValid !== false &&
                (entity.username?.toLowerCase() === name.toLowerCase() ||
                    (player.uuid &&
                        entity.uuid?.replace(/-/g, "").toLowerCase() ===
                            player.uuid.replace(/-/g, "").toLowerCase()));
            const entity =
                player.entity && player.entity.isValid !== false
                    ? player.entity
                    : Object.values(bot.entities || {}).find(matchingEntity);
            const candidate = entity && entity.isValid !== false ? entity.position : null;
            const position = candidate && [candidate.x, candidate.y, candidate.z].every(Number.isFinite) ? candidate : null;
            return {
                username: name,
                uuid: player.uuid || entity?.uuid || null,
                visible: Boolean(position),
                position: position
                    ? { x: position.x, y: position.y, z: position.z }
                    : null,
                distance:
                    position && bot.entity?.position
                        ? bot.entity.position.distanceTo(position)
                        : null,
            };
        });
}
module.exports = { playerState };

// Resolve from the same loaded-entity sources as observation, not tab-list presence alone.
function playerEntity(bot, name) {
    if (typeof name !== "string") return null;
    const entry = Object.entries(bot.players || {}).find(([key, value]) =>
        (value.username || key).toLowerCase() === name.toLowerCase());
    const listed = entry?.[1];
    const valid = e => e && e.isValid !== false && e.position && [e.position.x, e.position.y, e.position.z].every(Number.isFinite);
    if (valid(listed?.entity)) return listed.entity;
    return Object.values(bot.entities || {}).find(e => valid(e) &&
        ((e.username || bot.uuidToUsername?.[e.uuid] || "").toLowerCase() === name.toLowerCase() ||
         (listed?.uuid && e.uuid?.replace(/-/g, "").toLowerCase() === listed.uuid.replace(/-/g, "").toLowerCase()))) || null;
}
module.exports.playerEntity = playerEntity;
