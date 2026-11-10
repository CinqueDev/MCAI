// Only loaded entities have trustworthy current coordinates. Tab-list presence is not location.
function playerState(bot) {
    return Object.entries(bot.players || {})
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
            const position =
                entity && entity.isValid !== false ? entity.position : null;
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
