// UTF-16 length matches Minecraft's chat limits; never split a surrogate pair.
function splitReply(text, maximum) {
    const limit = maximum - 2; // Reserve the visible continuation marker.
    if (limit < 2) throw new Error("Chat length limit is too small");
    const parts = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = limit;
        const last = rest.charCodeAt(cut - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut--;
        const space = rest.lastIndexOf(" ", cut - 1);
        if (space >= cut / 2) cut = space + 1;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    // A later chunk beginning with '/' must never turn into a server command.
    return parts.map((part, index) => index ? "… " + part : part);
}

class ChatDelivery {
    constructor(conversation, { interval = 1200, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
        this.conversation = conversation;
        this.interval = interval;
        this.sleep = sleep;
        this.deliveries = new Map();
        this.tail = Promise.resolve();
        this.lastWireTime = -Infinity;
        this.closed = false;
        conversation.bot.once("end", () => { this.closed = true; });
    }
    existing(key) {
        const delivery = this.deliveries.get(key);
        return delivery && delivery.state !== "failed" ? delivery.promise : null;
    }
    enqueue(key, { clean, prefix, target, original, maximum }) {
        let delivery = this.deliveries.get(key);
        if (!delivery) {
            delivery = { parts: splitReply(clean, maximum - prefix.length), next: 0, clean, prefix, state: "queued" };
            this.deliveries.set(key, delivery);
        } else if (delivery.clean !== clean || delivery.prefix !== prefix) {
            throw new Error("Delivery key was reused with different content");
        }
        delivery.state = "queued";
        delivery.promise = this.tail.then(async () => {
            const conversation = this.conversation;
            while (delivery.next < delivery.parts.length) {
                if (this.closed) throw new Error("Minecraft disconnected before the reply finished");
                const wait = this.interval - (conversation.now() - this.lastWireTime);
                if (wait > 0) await this.sleep(wait);
                if (this.closed) throw new Error("Minecraft disconnected before the reply finished");
                const part = delivery.parts[delivery.next];
                conversation.rawChat(prefix + part);
                this.lastWireTime = conversation.now();
                conversation.record({ sender: conversation.bot.username, text: part,
                    channel: target ? "private" : "public", recipient: target || null,
                    outgoing: true, deliveryKey: key, part: delivery.next + 1, parts: delivery.parts.length });
                delivery.next++;
                conversation.lastSpoke = conversation.now();
            }
            if (original) conversation.pending.delete(original.id);
            delivery.state = "completed";
            // Keep retry receipts bounded, while retaining in-progress partial deliveries.
            for (const [oldKey, old] of this.deliveries) {
                if (this.deliveries.size <= 1000) break;
                if (old.state === "completed" && oldKey !== key) this.deliveries.delete(oldKey);
            }
            return { delivered: true, parts: delivery.parts.length };
        }).catch(error => { delivery.state = "failed"; throw error; });
        this.tail = delivery.promise.catch(() => {});
        return delivery.promise;
    }
}
module.exports = { ChatDelivery, splitReply };
