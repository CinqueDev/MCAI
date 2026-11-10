const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Conversation } = require('../lib/conversation');
const { parseControl, TaskController } = require('../lib/tasks');
const { CONTROLS, MEMORY, ACTIONS, INTERNAL_PRIMITIVES, SOCIAL, renderCommandHelp } = require('../lib/commandCatalog');

function fixture() {
    const wire = [];
    const bot = Object.assign(new EventEmitter(), { username: 'ItsDeltaBot', players: { Alice: {} }, chat: text => wire.push(text) });
    const conversation = new Conversation(bot, Date.now, { interval: 0 });
    return { bot, conversation, wire };
}

test('every registered command, alias and recall phrase is parsed and listed in help', () => {
    const help = renderCommandHelp('ItsDeltaBot');
    const names = new Set();
    for (const control of CONTROLS) {
        assert.ok(help.includes(control.usage));
        assert.ok(help.includes(control.description));
        for (const name of [control.name, ...(control.aliases || [])]) {
            assert.match(name, /^[a-z]+$/);
            assert.equal(names.has(name), false, `duplicate command ${name}`);
            names.add(name);
            assert.deepEqual(parseControl(`ItsDeltaBot, please ${name.toUpperCase()}!`, 'ItsDeltaBot'), { command: control.name, id: null });
        }
        for (const phrase of control.phrases || []) {
            assert.deepEqual(parseControl(phrase + '?', 'ItsDeltaBot'), { command: control.name, id: null });
        }
    }
    for (const text of ['Alice said cmds', 'do not show help', 'commands are useful', 'cmds task abcdef12']) {
        assert.equal(parseControl(text, 'ItsDeltaBot'), null);
    }
});

test('new action primitive files must be documented or explicitly classified as internal', () => {
    const files = fs.readdirSync(path.join(__dirname, '../../../control_primitives')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
    const documented = ACTIONS.map(a => a.primitive);
    const classified = [...documented, ...Object.keys(INTERNAL_PRIMITIVES)].sort();
    assert.deepEqual(classified, files, 'Update commandCatalog.js whenever action primitives change');
    const help = renderCommandHelp('ItsDeltaBot');
    for (const item of [...ACTIONS, ...MEMORY]) {
        for (const example of item.examples || [item.example]) assert.ok(help.includes(example));
    }
    for (const example of SOCIAL) assert.ok(help.includes(example));
});

test('public and private cmds deliver the complete help through the right channel without a task controller', async () => {
    for (const privateMessage of [false, true]) {
        const { bot, conversation, wire } = fixture();
        bot.emit(privateMessage ? 'whisper' : 'chat', 'Alice', 'cmds');
        await new Promise(setImmediate);
        await conversation.delivery.tail;
        assert.ok(wire.length > 1);
        const prefix = privateMessage ? '/msg Alice ' : '';
        assert.ok(wire.every(part => part.startsWith(prefix) && part.length <= 240));
        const content = wire.map((part, index) => part.slice(prefix.length + (index ? 2 : 0))).join('');
        assert.equal(content, renderCommandHelp(bot.username).replace(/\n/g, ' '));
        assert.equal(conversation.pending.size, 0);
        assert.equal(conversation.history[0].required, true);
        assert.equal(conversation.history[0].control, true);
        assert.deepEqual(conversation.snapshot().pending, []);
    }
});

test('requesting help never changes active tasks or suspension, even for another player', async () => {
    const { bot, conversation, wire } = fixture();
    bot.tasks = new TaskController(bot);
    const task = bot.tasks.enqueue({ task: 'Private secret project', requester: 'Bob', recipient: 'Bob' });
    bot.tasks.claim(task.id);
    bot.tasks.suspended = true;
    bot.tasks.suspendOwner = 'Bob';
    const before = JSON.stringify(bot.tasks.snapshot());
    bot.emit('whisper', 'Alice', 'help');
    await new Promise(setImmediate);
    await conversation.delivery.tail;
    assert.equal(JSON.stringify(bot.tasks.snapshot()), before);
    assert.ok(!wire.join(' ').includes('Private secret project'));
    assert.equal(await bot.tasks.control('cmds', 'Alice'), renderCommandHelp(bot.username));
});
