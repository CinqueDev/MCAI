// Recovery evidence is task-scoped. Inventory changes prove possession, not delivery.
function inventory(bot) {
    return bot.inventory?.items().map(i => ({ name: i.name, type: i.type,
        metadata: i.metadata, count: i.count })) || [];
}
function intent(name, args) {
    if (['toss', 'withdraw', 'deposit'].includes(name)) return {
        type: args[0], metadata: args[1] ?? null, count: args[2],
        direction: name === 'withdraw' ? 1 : -1,
    };
    if (name === 'tossStack' && args[0]) return { type: args[0].type,
        metadata: args[0].metadata ?? null, count: args[0].count, direction: -1 };
    return null;
}
function reconcile(task, bot) {
    const evidence = [];
    for (const action of task.actions || []) for (const op of action.operations || []) {
        if (!['started', 'uncertain'].includes(op.state) ||
            !(op.irreversible || ['craft', 'consume'].includes(op.name))) continue;
        const after = op.inventoryAfter || inventory(bot);
        const detail = { name: op.name, intent: op.intent || null,
            before: op.inventoryBefore || null, after, outcome: 'unknown', remaining: null };
        const request = op.intent;
        if (request && Number.isInteger(request.count) && request.count > 0 && op.inventoryBefore) {
            const count = items => items.filter(i => i.type === request.type &&
                (request.metadata === null || i.metadata === request.metadata)).reduce((n, i) => n + i.count, 0);
            const changed = (count(after) - count(op.inventoryBefore)) * request.direction;
            // No change cannot establish that the server never performed a transaction.
            if (changed > 0 && changed <= request.count) {
                detail.outcome = 'inventory_change_observed';
                detail.changed = changed;
                detail.remaining = request.count - changed;
            }
        }
        op.state = 'reconciled';
        op.recovery = detail;
        evidence.push(detail);
    }
    if (evidence.length) {
        task.recoveryEvidence = [...(task.recoveryEvidence || []), ...evidence];
        task.recovery = true;
    }
    task.needsReview = false;
    return evidence;
}
function guard(task, name, args) {
    const request = intent(name, args);
    const allowed = [];
    const family = value => value === 'tossStack' ? 'toss' : value;
    for (const evidence of task?.recoveryEvidence || []) {
        if (evidence.superseded || family(evidence.name) !== family(name)) continue;
        if (evidence.intent && request && (request.type !== evidence.intent.type ||
            request.metadata !== evidence.intent.metadata)) continue;
        if (evidence.remaining === null)
            throw new Error(`Recovery: the earlier ${name} has an unknown outcome. Inspect the live inventory/world and pursue the remaining goal without repeating this uncertain operation.`);
        if (!request || !Number.isInteger(request.count) || evidence.remaining === 0 || request.count !== evidence.remaining)
            throw new Error(`Recovery: inventory already changed by ${evidence.changed}; at most ${evidence.remaining} items remain for ${name}. Verify delivery and replan; do not repeat the original quantity.`);
        // The next operation records its own before/after evidence before execution.
        allowed.push(evidence);
    }
    for (const evidence of allowed) evidence.superseded = true;
    return allowed;
}
module.exports = { inventory, intent, reconcile, guard };
