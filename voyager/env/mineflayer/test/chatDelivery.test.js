const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Conversation } = require('../lib/conversation');
const { parseLocationMemory } = require('../lib/locationMemory');

function fixture(options = {}) {
    const bot = Object.assign(new EventEmitter(), { username: 'Voyager', players: { Alice: {} } });
    const wire = [];
    bot.chat = text => wire.push(text);
    let time = 1000;
    const waits = [];
    const chat = new Conversation(bot, () => time, { sleep: async ms => { waits.push(ms); time += ms; }, ...options });
    return { bot, wire, chat, waits };
}
function reconstruct(wire, prefix = '') {
    return wire.map((s, i) => s.slice(prefix.length + (i ? 2 : 0))).join('');
}

test('long public and private replies preserve all text, Unicode and routing with paced chunks', async () => {
    for (const privateReply of [false, true]) {
        const { bot, wire, chat, waits } = fixture();
        bot.supportFeature = () => privateReply; // Also exercise the legacy 100-character limit.
        bot.emit(privateReply ? 'whisper' : 'chat', 'Alice', 'Voyager help');
        const text = 'Here are the directions 🌎 ' + 'follow the path 😀 '.repeat(35);
        const payload = { session: chat.session, replyTo: 1, key: 'long', text };
        const pending = chat.send(payload);
        assert.equal(chat.pending.size, 1);
        assert.equal(chat.send(payload), pending);
        const result = await pending;
        assert.ok(result.parts > 2);
        const prefix = privateReply ? '/msg Alice ' : '';
        assert.equal(reconstruct(wire, prefix), text.trim());
        assert.ok(wire.every(s => s.length <= (privateReply ? 100 : 240) && s.startsWith(prefix)));
        assert.ok(wire.every(s => !/[\uD800-\uDBFF]$/.test(s)));
        assert.deepEqual(waits, Array(wire.length - 1).fill(1200));
        assert.equal(chat.pending.size, 0);
        await chat.send(payload);
        assert.equal(wire.length, result.parts);
    }
});

test('a failed multipart delivery resumes after the last successful chunk', async () => {
    const { wire, chat } = fixture({ interval: 0 });
    const raw = chat.rawChat;
    let failed = false;
    chat.rawChat = text => {
        if (wire.length === 1 && !failed) { failed = true; throw new Error('temporary send failure'); }
        raw(text);
    };
    const text = 'long message '.repeat(60).trim();
    const payload = { session: chat.session, key: 'retry', text };
    await assert.rejects(chat.send(payload), /temporary send/);
    assert.equal(wire.length, 1);
    await chat.send(payload);
    assert.equal(reconstruct(wire), text);
});

test('disconnect prevents remaining chunks and continuation text cannot execute commands', async () => {
    const { bot, wire, chat } = fixture({ sleep: async () => bot.emit('end') });
    const text = 'a'.repeat(238) + '/op Alice';
    await assert.rejects(chat.send({ session: chat.session, key: 'end', text }), /disconnected/);
    assert.equal(wire.length, 1);
    const other = fixture({ interval: 0 });
    await other.chat.send({ session: other.chat.session, key: 'slash', text });
    assert.equal(other.wire[1], '… /op Alice');
});

test('location write requests are mandatory without a tag and loaded players need no tab-list entry', () => {
    const { bot, chat } = fixture();
    bot.players = {};
    bot.entities = { 1: { username: 'Alice', type: 'player', position: { x: -12, y: 70, z: 19 } } };
    bot.emit('chat', 'Alice', 'Can you save my coords as home please?');
    for (let i = 0; i < 110; i++) bot.emit('chat', 'Bob', 'ambient');
    const saved = chat.snapshot().pending[0];
    assert.equal(saved.required, true);
    assert.deepEqual(saved.locationMemory, { name: 'home' });
    assert.deepEqual(saved.requesterLocation, { x: -12, y: 70, z: 19 });
    assert.equal(chat.snapshot().noPlayersOnline, false);
});

test('location parser handles explicit named writes without mistaking recall or discussion for writes', () => {
    for (const text of ['remember here as home', 'Hey Voyager, save my current position as home!',
        'note home at my location', 'save this position under the name home', 'mark my coords as home, Voyager']) {
        assert.deepEqual(parseLocationMemory(text, 'Voyager'), { name: 'home' }, text);
    }
    assert.deepEqual(parseLocationMemory('save my location'), { name: null });
    for (const text of ['do you remember here as home?', 'Bob said remember here as home', 'where is home?', 'hello']) {
        assert.equal(parseLocationMemory(text, 'Voyager'), null, text);
    }
});

test('natural current-location requests are required and capture coordinates without a name or tag', () => {
    const { bot, chat } = fixture();
    bot.game = { dimension: 'overworld' };
    bot.entities = { 1: { username: 'Alice', type: 'player', position: { x: 4, y: 64, z: 8 } } };
    const phrases = [
        'Can you remember the location I am currently at?',
        "Can you remember the location I'm currently at?",
        'Please save where I’m standing right now.',
        'remember where I currently am',
        'Hey Voyager, save the place I am at, please!',
        'save the location that I am currently at',
    ];
    for (const text of phrases) {
        bot.emit('chat', 'Alice', text);
        const message = chat.snapshot().pending.at(-1);
        assert.deepEqual(parseLocationMemory(text, 'Voyager'), { name: null }, text);
        assert.equal(message.text, text);
        assert.deepEqual(message.requesterLocation, { x: 4, y: 64, z: 8 });
        assert.equal(message.requesterDimension, 'overworld');
    }
    for (const text of ["Do you remember the location I am currently at?", "Don't save where I'm standing", 'remember where Bob is']) {
        assert.equal(parseLocationMemory(text, 'Voyager'), null, text);
    }
    assert.deepEqual(parseLocationMemory('Remember the location I am currently at as home'), { name: 'home' });
});
