// Also recognize vanilla namespaced commands and commands nested in execute/return.
// This guards normal command dispatch, not arbitrary access to the protocol client.
function assertWorldCommandAllowed(bot, message) {
    if (bot.allowWorldChanges !== false) return;
    let command = String(message).trim();
    if (!command.startsWith("/")) return;
    command = command.slice(1).trimStart();
    while (command) {
        const name = command.split(/\s+/, 1)[0].replace(/^minecraft:/i, "").toLowerCase();
        if (["tick", "difficulty", "time", "gamerule", "pause"].includes(name)) {
            throw new Error("World setting commands are disabled by mc_allow_world_changes=false");
        }
        if (name !== "execute" && name !== "return") return;
        const run = /\brun\s+/i.exec(command);
        if (!run) return;
        command = command.slice(run.index + run[0].length).trimStart();
    }
}

module.exports = { assertWorldCommandAllowed };
