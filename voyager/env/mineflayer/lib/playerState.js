// Only loaded entities have trustworthy current coordinates. Tab-list presence is not location.
function playerState(bot) {
    return Object.entries(bot.players || {})
        .filter(([name]) => name.toLowerCase() !== bot.username?.toLowerCase())
        .map(([name, player]) => {
            const entity = player.entity;
            const position = entity && entity.isValid !== false ? entity.position : null;
            return { username: name, uuid: player.uuid || entity?.uuid || null, visible: Boolean(position),
                position: position ? { x: position.x, y: position.y, z: position.z } : null,
                distance: position && bot.entity?.position ? bot.entity.position.distanceTo(position) : null };
        });
}
module.exports = { playerState };
