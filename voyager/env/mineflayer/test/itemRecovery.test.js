const { test } = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('../lib/itemRecovery');
const item = count => [{ type:7, metadata:0, name:'iron_ingot', count }];
function record(name, before, after, count) {
    return { actions:[{ operations:[{ name, irreversible:true, state:'uncertain',
        inventoryBefore:item(before), inventoryAfter:item(after), intent:recovery.intent(name,[7,0,count]) }] }] };
}
test('completed withdrawal cannot be replayed and evidence survives another reconciliation', () => {
    const task = record('withdraw', 1, 6, 5);
    recovery.reconcile(task, {});
    assert.equal(task.recoveryEvidence[0].remaining, 0);
    assert.throws(() => recovery.guard(task,'withdraw',[7,0,5]), /at most 0/);
    recovery.reconcile(task, {});
    assert.equal(task.recoveryEvidence.length,1);
});
test('unchanged or unrelated inventory does not prove a failed transaction can be retried', () => {
    for (const after of [5, 10]) {
        const task = record('deposit',5,after,3);
        recovery.reconcile(task, {});
        assert.equal(task.recoveryEvidence[0].outcome,'unknown');
        assert.throws(() => recovery.guard(task,'deposit',[7,0,3]), /unknown outcome/);
    }
});
test('newly opened inventory is used only when no settled after receipt exists', () => {
    const task = record('toss',8,8,5);
    delete task.actions[0].operations[0].inventoryAfter;
    recovery.reconcile(task,{inventory:{items:()=>item(5)}});
    assert.equal(task.recoveryEvidence[0].remaining,2);
    // Guarding an unrelated item does not use up the remaining transfer receipt.
    recovery.guard(task,'toss',[9,0,2]);
    assert.equal(task.recoveryEvidence[0].superseded,undefined);
    assert.throws(()=>recovery.guard(task,'toss',[7,0,5]), /at most 2/);
});
test('changing from toss to tossStack cannot bypass a recovered drop receipt', () => {
    const task = record('toss',8,3,5);
    recovery.reconcile(task,{});
    assert.throws(()=>recovery.guard(task,'tossStack',[{type:7,metadata:0,count:5}]), /at most 0/);
});
