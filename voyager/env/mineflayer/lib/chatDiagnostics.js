// Observe packet metadata only; never retain chat text, signatures, keys or tokens.
function observeChatPackets(bot) {
    const client = bot._client, recent = [];
    if (typeof client?.write !== 'function') return () => recent;
    const original = client.write;
    function write(name, packet, ...args) {
        if (['chat_message', 'chat_command', 'chat_command_signed', 'message_acknowledgement'].includes(name)) {
            recent.push({ packet:name, sentAt:Date.now(),
                timestamp:packet.timestamp == null ? null : String(packet.timestamp),
                characters:(packet.message || packet.command || '').length,
                signed:Boolean(packet.signature?.length || packet.argumentSignatures?.length),
                count:packet.messageCount ?? packet.offset ?? packet.count ?? null,
                checksum:packet.checksum ?? null });
            if (recent.length > 8) recent.shift();
        }
        return original.call(this, name, packet, ...args);
    }
    client.write = write;
    bot.once('end', () => { if (client.write === write) client.write = original; });
    return () => recent.slice();
}
module.exports = { observeChatPackets };
