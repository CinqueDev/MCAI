// Wait for command feedback, not world ticks: those are frozen by /tick freeze.
function tickPause(bot, paused, timeoutMs = 5000) {
    const expected = paused ? "commands.tick.status.frozen" : "commands.tick.status.running";
    return new Promise((resolve, reject) => {
        const finish = (error) => {
            clearTimeout(timer);
            bot.removeListener("message", onMessage);
            bot.removeListener("end", onEnd);
            if (error) reject(error);
            else resolve();
        };
        const onEnd = () => finish(new Error("Disconnected while changing tick freeze state"));
        const onMessage = (message) => {
            const key = message.json?.translate;
            if (key === expected) finish();
            else if (key === "command.unknown.command" || key === "command.unknown.argument" ||
                     key === "commands.generic.permission" || key === "commands.generic.failed") {
                finish(new Error(`Tick pause rejected: ${message.toString()}`));
            }
        };
        const timer = setTimeout(() => finish(new Error(
            "No /tick confirmation: requires Java 1.20.3+, operator permissions and sendCommandFeedback=true"
        )), timeoutMs);
        bot.on("message", onMessage);
        bot.once("end", onEnd);
        try {
            bot.chat(paused ? "/tick freeze" : "/tick unfreeze");
        } catch (error) {
            finish(error);
        }
    });
}

async function setPaused(bot, mode, paused) {
    if (bot.allowWorldChanges === false) return;
    if (mode === "none") return;
    if (mode === "tick") {
        try {
            await tickPause(bot, paused);
        } catch (error) {
            // Feedback may be disabled even though the freeze succeeded.
            if (paused) bot.chat("/tick unfreeze");
            throw error;
        }
    } else if (mode === "mod") {
        bot.chat("/pause");
        await bot.waitForTicks(bot.waitTicks);
    } else {
        throw new Error("Invalid pause mode");
    }
}

module.exports = { tickPause, setPaused };
