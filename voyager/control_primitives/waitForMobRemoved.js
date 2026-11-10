function waitForMobOutcome(bot, entity, timeout, ranged) {
    return new Promise((resolve, reject) => {
        let droppedItem = null;
        const signal = bot.taskSignal?.();
        const stopped = ranged ? "auto_shot_stopped" : "stoppedAttacking";
        const stop = () => (ranged ? bot.hawkEye.stop() : bot.pvp.stop());
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            bot.removeListener("entityGone", onGone);
            bot.removeListener("itemDrop", onDrop);
            bot.removeListener(stopped, onStopped);
        };
        const onAbort = () => {
            cleanup();
            stop();
            const error = new Error("Combat was stopped");
            error.name = "TaskInterrupted";
            reject(error);
        };
        const onGone = (target) => {
            if (target !== entity) return;
            cleanup();
            stop();
            resolve(droppedItem);
        };
        const onDrop = (item) => {
            if (entity.position.distanceTo(item.position) <= 1)
                droppedItem = item;
        };
        const onStopped = () => {
            cleanup();
            reject(new Error(`Failed to defeat ${entity.name}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            stop();
            reject(new Error(`Timed out defeating ${entity.name}`));
        }, timeout * 1000);
        bot.on("entityGone", onGone);
        bot.on("itemDrop", onDrop);
        bot.on(stopped, onStopped);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}
function waitForMobRemoved(bot, entity, timeout = 300) {
    return waitForMobOutcome(bot, entity, timeout, false);
}
function waitForMobShot(bot, entity, timeout = 300) {
    return waitForMobOutcome(bot, entity, timeout, true);
}
