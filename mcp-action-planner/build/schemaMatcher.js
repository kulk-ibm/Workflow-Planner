/**
 * schemaMatcher.ts
 *
 * Semantic field-matching engine.
 *
 * Given an input field from the primary action and a set of candidate output
 * fields from supporting actions, this module computes a similarity score and
 * returns the best match (if any exceeds the acceptance threshold).
 *
 * Scoring considers:
 *  1. Exact name match
 *  2. Normalized name similarity (camelCase / snake_case / Title Case aware)
 *  3. Suffix match (e.g. "cardId" ends with "Id", "id" is a common ID suffix)
 *  4. Parent-object context (e.g. output field "cards[].id" with parent "cards"
 *     scores higher against input "cardId")
 *  5. Type compatibility
 *  6. Title / displayTitle similarity
 *  7. Description keyword overlap
 */
// ─── Text normalisation helpers ───────────────────────────────────────────────
/** Convert camelCase / PascalCase / snake_case / "Title Case" to tokens.
 *  Also handles Trello-style id-prefix fields like "idBoard" → ["id","board"]
 *  and "idList" → ["id","list"].
 */
function tokenize(text) {
    return text
        .replace(/\bid([A-Z])/g, "id $1") // idBoard → id Board
        .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/[_\-\s.[\],;:!?'"]+/g, " ") // also strip commas and punctuation
        .toLowerCase()
        .split(" ")
        .map((t) => t.trim())
        .filter(Boolean);
}
function normalize(text) {
    return tokenize(text).join(" ");
}
/** Jaccard similarity between two token sets */
function jaccard(a, b) {
    if (!a.length || !b.length)
        return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const t of setA)
        if (setB.has(t))
            intersection++;
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
/** Common ID-bearing token patterns */
const ID_TOKENS = new Set(["id", "identifier", "key", "uuid", "gid", "oid"]);
const NAME_TOKENS = new Set(["name", "title", "label", "caption", "text", "slug"]);
/** True if the field seems to carry an identifier value */
function looksLikeId(field) {
    const tokens = tokenize(field.name + " " + field.title + " " + field.description);
    return tokens.some((t) => ID_TOKENS.has(t));
}
/** True if the field seems to carry a display/name value */
function looksLikeName(field) {
    const tokens = tokenize(field.name + " " + field.title + " " + field.description);
    return tokens.some((t) => NAME_TOKENS.has(t));
}
// ─── Entity extraction ────────────────────────────────────────────────────────
/**
 * Extract the "entity noun" from a field path.
 * e.g. "cards[].id"      → "card"
 *      "board_id"         → "board"
 *      "label_id"         → "label"
 *      "cards[].idBoard"  → "board"   (Trello id-prefix style)
 *      "data.card.id"     → "card"
 */
function extractEntityNoun(field) {
    // "label" is intentionally excluded from genericTokens because in many
    // connectors (e.g. Trello) "label" IS the entity noun (labels[].id, label_id).
    const genericTokens = new Set([
        "id", "name", "title", "type", "data", "value", "items",
        "result", "results", "output", "outputs", "response",
    ]);
    const pathTokens = tokenize(field.path.replace(/\[\]/g, ""));
    const nameTokens = tokenize(field.name);
    const allTokens = [...pathTokens, ...nameTokens];
    for (let i = allTokens.length - 1; i >= 0; i--) {
        if (!genericTokens.has(allTokens[i]) && allTokens[i].length > 1) {
            return allTokens[i];
        }
    }
    return "";
}
// ─── Core scoring ─────────────────────────────────────────────────────────────
export const MATCH_THRESHOLD = 0.35; // Minimum score to consider a match
/**
 * Score how well `outputField` can satisfy `inputField`.
 * Returns a score in [0, 1] and a human-readable reason string.
 */
export function scoreMatch(inputField, outputField) {
    let score = 0;
    const reasons = [];
    const inName = normalize(inputField.name);
    const outName = normalize(outputField.name);
    const inTitle = normalize(inputField.title);
    const outTitle = normalize(outputField.title);
    // 1. Exact field name match
    if (inName === outName) {
        score += 0.5;
        reasons.push("exact name match");
    }
    // 2. Normalized Jaccard on names
    const inTokens = tokenize(inputField.name + " " + inputField.title);
    const outTokens = tokenize(outputField.name + " " + outputField.title + " " + outputField.path);
    const nameJaccard = jaccard(inTokens, outTokens);
    if (nameJaccard > 0) {
        score += nameJaccard * 0.35;
        if (nameJaccard > 0.3)
            reasons.push(`name similarity ${(nameJaccard * 100).toFixed(0)}%`);
    }
    // 3. Entity noun match (e.g. both reference "card")
    const inEntity = extractEntityNoun(inputField);
    const outEntity = extractEntityNoun(outputField);
    if (inEntity && outEntity && inEntity === outEntity) {
        score += 0.2;
        reasons.push(`entity match "${inEntity}"`);
    }
    // 4. Both look like ID fields → partial bonus
    if (looksLikeId(inputField) && looksLikeId(outputField)) {
        score += 0.15;
        reasons.push("both are ID fields");
    }
    // 5. Both look like name/title fields → partial bonus
    if (looksLikeName(inputField) && looksLikeName(outputField)) {
        score += 0.1;
        reasons.push("both are name fields");
    }
    // 6. Type compatibility (penalise mismatches)
    if (inputField.type !== outputField.type) {
        score *= 0.85;
    }
    // 7. Description keyword overlap
    const descOverlap = jaccard(tokenize(inputField.description), tokenize(outputField.description));
    score += descOverlap * 0.1;
    // 8. Parent key context bonus: if the output lives in an array whose name
    //    starts with the entity noun of the input (e.g. cards[].id → card_id)
    if (outputField.isArrayItem) {
        const arrayParentNoun = normalize(outputField.parentKey).replace(/s$/, ""); // simple deplural
        if (inEntity && (arrayParentNoun === inEntity || inEntity.startsWith(arrayParentNoun))) {
            score += 0.2;
            reasons.push(`array parent "${outputField.parentKey}" matches entity "${inEntity}"`);
        }
        // Bonus: parent array entity matches input entity even if names differ
        // e.g. cards[].idBoard → board_id: parent=cards, inEntity=board
        const parentNounTokens = tokenize(outputField.parentKey.replace(/s$/, ""));
        const outEntityTokens = new Set(tokenize(outputField.name));
        if (inEntity && parentNounTokens.some((t) => outEntityTokens.has(t))) {
            score += 0.1;
        }
    }
    const clampedScore = Math.min(score, 1.0);
    return {
        outputField,
        score: clampedScore,
        reason: reasons.length ? reasons.join(", ") : "low similarity",
    };
}
/**
 * Find the best-matching output field for the given input field across all
 * candidate output fields. Returns null when no match exceeds MATCH_THRESHOLD.
 */
export function findBestMatch(inputField, candidateOutputs) {
    let best = null;
    for (const outField of candidateOutputs) {
        const m = scoreMatch(inputField, outField);
        if (!best || m.score > best.score)
            best = m;
    }
    if (!best || best.score < MATCH_THRESHOLD)
        return null;
    return best;
}
/**
 * Rank a list of actions by how well their description + action name match the
 * given intent tokens. Returns the sorted list (best match first).
 */
export function rankActionsByIntent(intentTokens, actions) {
    // Stop words stripped from intent tokens by parseRequest — strip the same
    // set from label tokens so substring matching works correctly.
    const intentStopWords = new Set([
        "a", "an", "the", "to", "in", "on", "using", "via", "for", "with",
        "of", "from", "into", "at", "by", "and", "or", "but",
    ]);
    // Synonym map: user verb → action label verbs it is equivalent to.
    // Expands intentTokens so e.g. "download" matches actions labelled "get" or "fetch".
    const VERB_SYNONYMS = {
        download: ["get", "fetch", "download", "retrieve", "export"],
        upload: ["upload", "create", "add", "import", "put"],
        get: ["get", "fetch", "retrieve", "download"],
        fetch: ["fetch", "get", "retrieve", "download"],
        retrieve: ["retrieve", "get", "fetch", "download"],
        send: ["send", "post", "publish", "create"],
        post: ["post", "send", "create", "publish"],
        create: ["create", "add", "new", "insert", "post"],
        add: ["add", "create", "insert", "append"],
        remove: ["remove", "delete", "archive"],
        delete: ["delete", "remove", "archive"],
        update: ["update", "edit", "modify", "set", "patch"],
        edit: ["edit", "update", "modify"],
        search: ["search", "find", "list", "query", "lookup"],
        find: ["find", "search", "get", "list", "lookup"],
        list: ["list", "search", "find", "query"],
    };
    // Build expanded intent set including synonyms for any verb tokens
    const intentSet = new Set(intentTokens);
    const expandedIntentSet = new Set(intentTokens);
    for (const token of intentTokens) {
        const synonyms = VERB_SYNONYMS[token];
        if (synonyms)
            synonyms.forEach((s) => expandedIntentSet.add(s));
    }
    const intentNorm = intentTokens.join(" ");
    function score(action) {
        const labelTokens = tokenize(action.label);
        const descTokens = tokenize(action.description);
        // Label tokens without stop words — aligned with intentTokens
        const labelCoreTokens = labelTokens.filter((t) => !intentStopWords.has(t));
        // Base Jaccard over label + description (using expanded intent set for synonyms)
        const expandedIntentArr = [...expandedIntentSet];
        let s = jaccard(expandedIntentArr, [...labelTokens, ...descTokens]);
        // Boost 1: label core tokens are covered by the intent tokens (with synonyms)
        // e.g. intent ["download","file"] expands to cover label core ["get","file"]
        const labelCoreSet = new Set(labelCoreTokens);
        const labelInIntent = [...labelCoreSet].filter((t) => expandedIntentSet.has(t)).length;
        const labelCoverage = labelCoreSet.size > 0 ? labelInIntent / labelCoreSet.size : 0;
        s += labelCoverage * 0.3;
        // Boost 2: label core tokens (stop-word-stripped) appear as a contiguous
        // subsequence in the intent — catches verbatim action names in the request
        const labelCoreNorm = labelCoreTokens.join(" ");
        if (labelCoreNorm && intentNorm.includes(labelCoreNorm))
            s += 0.4;
        // Penalty: label contains tokens that have NO overlap with the expanded intent.
        // This prevents "Get File Comments" beating "Get File" when intent is ["download","file"] —
        // "comments" is present in the label but absent from intent, reducing its score.
        const labelExtraTokens = labelCoreTokens.filter((t) => !expandedIntentSet.has(t));
        const extraRatio = labelCoreTokens.length > 0
            ? labelExtraTokens.length / labelCoreTokens.length
            : 0;
        s -= extraRatio * 0.25;
        return s;
    }
    return [...actions].sort((a, b) => score(b) - score(a));
}
export { tokenize };
