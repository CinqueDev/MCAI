// Recognize explicit writes, not recall questions or quoted instructions.
function parseLocationMemory(text, username = "") {
    if (typeof text !== "string") return null;
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let input = text.trim().replace(/’/g, "'");
    if (escaped) {
        input = input.replace(new RegExp(`^(?:(?:hey|hi)\\s+)?@?${escaped}(?:[,!:]\\s*|\\s+)`, "i"), "");
        input = input.replace(new RegExp(`[, ]+@?${escaped}[.!?]?$`, "i"), "");
    }
    input = input.replace(/(?:,?\s+please|\s+for later)[.!?]?$/i, "").replace(/[.!?]+$/, "").trim();
    const polite = "(?:(?:can|could|would) you\\s+)?(?:please\\s+)?";
    // Keep in sync with CURRENT_PLAYER_PLACE in voyager/world_memory.py.
    const place = "(?:here|this (?:location|place|spot|position)|" +
        "my (?:current )?(?:location|position|coordinates|coords)|" +
        "(?:the )?(?:location|place|spot|position) (?:where |that )?" +
        "I(?: am|'m) (?:currently )?(?:at|in|standing)|" +
        "where I(?: am|'m)(?: (?:currently )?(?:standing|located))?|" +
        "where I currently am)(?: (?:right )?now)?";
    const verb = "(?:remember|save|mark|note)";
    const labelled = input.match(new RegExp(`^${polite}${verb}\\s+${place}\\s+(?:as|named|called|under the name)\\s+(?:my\\s+|our\\s+)?(.{1,80})$`, "i"));
    const reversed = input.match(new RegExp(`^${polite}${verb}\\s+(?:my\\s+|our\\s+)?(.{1,80}?)\\s+(?:at|using)\\s+${place}$`, "i"));
    const match = labelled || reversed;
    if (match) {
        const name = match[1].trim().replace(/^["']|["']$/g, "").trim();
        return name ? { name } : { name: null };
    }
    if (new RegExp(`^${polite}${verb}\\s+${place}$`, "i").test(input)) return { name: null };
    return null;
}
module.exports = { parseLocationMemory };
