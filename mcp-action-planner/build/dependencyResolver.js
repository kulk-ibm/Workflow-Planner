/**
 * dependencyResolver.ts
 *
 * Core planning engine:
 *
 *  1. Given a primary action and its required input fields, classifies each
 *     field as DIRECT / RESOLVABLE_BY_ACTION / AMBIGUOUS / MISSING.
 *
 *  2. For RESOLVABLE_BY_ACTION fields, searches all available actions (and
 *     optionally triggers) for an action whose output field semantically
 *     matches the required input field.
 *
 *  3. Builds a DependencyNode graph.
 *
 *  4. Topologically sorts nodes to produce the execution order.
 *
 *  No application-specific rules exist here — everything is driven by the
 *  metadata schemas and the semantic matcher.
 */
import { scoreMatch, MATCH_THRESHOLD, tokenize } from "./schemaMatcher.js";
// ─── Classify a single input field ───────────────────────────────────────────
/**
 * Decide whether an input field can be directly populated from the user's
 * stated entity values.
 *
 * Heuristic: if the field title/name/description contains the entity noun
 * (e.g. "cardName", "name") AND the user supplied a value for that noun,
 * classify as DIRECT and fill the value.
 */
/**
 * Field names (or suffixes) that indicate a system-generated ID which can
 * never be satisfied directly from a user's natural-language input.
 * These fields must always be resolved via a supporting action.
 */
/**
 * True when a field is a connection-level credential (OAuth token, API key, etc.)
 * that is configured by the user when they connect the app — not a workflow data
 * input that needs to be resolved from other actions.
 */
function isAuthField(field) {
    const nameLower = field.name.toLowerCase();
    const titleLower = field.title.toLowerCase();
    const descLower = field.description.toLowerCase();
    return (field.name === "auth" ||
        field.path.startsWith("auth") ||
        nameLower === "token" ||
        nameLower === "accesstoken" ||
        nameLower === "apikey" ||
        nameLower === "api_key" ||
        nameLower === "secret" ||
        nameLower === "clientsecret" ||
        nameLower === "client_secret" ||
        nameLower === "bearertoken" ||
        nameLower === "bearer_token" ||
        titleLower.startsWith("authorize") ||
        titleLower.includes("api key") ||
        titleLower.includes("oauth") ||
        titleLower.includes("access token") ||
        descLower.includes("authorize"));
}
function isIdField(field) {
    const n = field.name.toLowerCase();
    return (n === "id" ||
        n.endsWith("_id") ||
        n.endsWith("id") || // e.g. "boardId", "cardId", "labelId"
        field.title.toLowerCase().endsWith(" id"));
}
function tryDirectClassify(field, entityValues) {
    // ID fields (board_id, card_id, label_id, …) are NEVER directly satisfied
    // from user input — they require a supporting action to look them up.
    if (isIdField(field))
        return null;
    const fieldTokens = new Set(tokenize(field.name + " " + field.title + " " + field.description));
    // "query" / "search" fields whose description mentions "name" → map to entity value
    // e.g. Trello Search Cards has field "query" described as "Enter the name or shortURL..."
    const isSearchQueryField = (field.name === "query" || fieldTokens.has("query") || fieldTokens.has("search")) &&
        (fieldTokens.has("name") || fieldTokens.has("title") || fieldTokens.has("search"));
    for (const [entityNoun, entityValue] of entityValues) {
        const entityTokens = tokenize(entityNoun);
        const nameTokens = new Set(["name", "title", "label", "caption", "text", "query", "search"]);
        // Field tokens must contain the entity noun AND a name-like token
        const hasEntityNoun = entityTokens.some((t) => fieldTokens.has(t));
        const hasNameToken = [...fieldTokens].some((t) => nameTokens.has(t));
        if (hasEntityNoun && hasNameToken) {
            return { status: "DIRECT", value: entityValue };
        }
        // Search/query field: use the first entity value as the query term
        if (isSearchQueryField && entityNoun === [...entityValues.keys()][0]) {
            return { status: "DIRECT", value: entityValue };
        }
        // Top-level "name" field when there is only one entity
        if (field.name === "name" && entityValues.size === 1) {
            return { status: "DIRECT", value: entityValue };
        }
    }
    return null;
}
/**
 * True when an action's output field for a given input looks like an echo
 * (the action takes the same field as a required input and returns it unchanged).
 *
 * Echo actions (write/mutate) are not valid data sources for dependency resolution
 * because they require the value to already be known before they can run.
 */
function isEchoField(outputField, inputField, actionInputFields) {
    // If the action's own required input fields include a field whose path
    // exactly matches the output field's path, it is an echo.
    return actionInputFields.some((f) => f.required && f.path === outputField.path);
}
/**
 * Prefer "read" actions (search/get/list/find/fetch) over "write" actions
 * as data sources. Returns a multiplier applied to the score.
 *
 * A high multiplier for reads vs writes is intentional: a write action that
 * happens to echo a field in its output is NOT a valid data source for that
 * field — only read actions that independently compute or retrieve the value
 * should be chosen.
 */
function dataSourceBonus(actionLabel) {
    const lbl = actionLabel.toLowerCase();
    const readPrefixes = ["search", "get", "list", "find", "fetch", "lookup", "query"];
    // Read actions: full score
    // Write/mutate actions: heavy penalty — they cannot independently supply IDs
    return readPrefixes.some((p) => lbl.startsWith(p)) ? 1.0 : 0.2;
}
/**
 * Return a [0,1] bonus for an action that has a non-required "name" or "query"
 * type input field — meaning it can be driven by user-supplied entity values
 * without needing to already know any IDs.
 *
 * Actions whose ONLY required inputs are ID fields (meaning you must already
 * know the IDs) are penalised because they cannot bootstrap the lookup chain.
 */
function selfSufficientBonus(action) {
    const requiredInputs = action.inputFields.filter((f) => f.required && f.name !== "auth" && !f.path.startsWith("auth"));
    if (requiredInputs.length === 0)
        return 0.9; // no required inputs → can always run
    const allRequiredAreIds = requiredInputs.every((f) => isIdField(f));
    if (allRequiredAreIds)
        return 0.4; // needs IDs to run → not self-sufficient
    // Has at least one non-ID required input (e.g. query, name) → can be seeded by user
    return 1.0;
}
/**
 * For each required-but-not-direct input field, search all available actions
 * (and triggers when included) for the best-matching output field.
 *
 * Echo fields (where the action itself requires the same value as input)
 * are excluded so that write/mutate actions are never chosen as resolvers.
 *
 * Actions whose required inputs are all IDs (not self-sufficient) are
 * penalised so that actions that can be driven purely by user-supplied names
 * are preferred.
 */
function findResolvingAction(inputField, candidateActions) {
    let best = null;
    for (const action of candidateActions) {
        const dsBonus = dataSourceBonus(action.summary.label);
        const ssBonus = selfSufficientBonus(action);
        for (const outField of action.outputFields) {
            // Skip echo fields
            if (isEchoField(outField, inputField, action.inputFields))
                continue;
            const m = scoreMatch(inputField, outField);
            // Apply the threshold to the raw semantic score before bonuses.
            // Bonuses adjust the relative ranking but shouldn't disqualify valid matches.
            if (m.score < MATCH_THRESHOLD)
                continue;
            // Combined score: semantic match × read-action preference × self-sufficiency
            // Use a reduced threshold for the adjusted score to allow penalised but valid matches.
            const adjustedScore = m.score * dsBonus * ssBonus;
            if (adjustedScore < MATCH_THRESHOLD * 0.2)
                continue; // filter noise only
            if (!best || adjustedScore > best.score) {
                best = {
                    actionName: action.summary.label,
                    actionId: action.summary.id,
                    outputField: outField,
                    score: adjustedScore,
                    matchReason: m.reason,
                };
            }
        }
    }
    return best;
}
// ─── Input classification ─────────────────────────────────────────────────────
export function classifyInputs(requiredInputs, entityValues, supportingActions, primaryActionName) {
    const classified = [];
    for (const field of requiredInputs) {
        if (!field.required)
            continue;
        // Skip auth / credential fields — connection-level config, not workflow data
        if (isAuthField(field))
            continue;
        // 1. Try DIRECT resolution from user-supplied values
        const direct = tryDirectClassify(field, entityValues);
        if (direct) {
            classified.push({
                fieldPath: field.path,
                fieldTitle: field.title,
                status: "DIRECT",
                directValue: direct.value,
            });
            continue;
        }
        // 2. Try RESOLVABLE_BY_ACTION
        const candidate = findResolvingAction(field, supportingActions);
        if (candidate) {
            classified.push({
                fieldPath: field.path,
                fieldTitle: field.title,
                status: "RESOLVABLE_BY_ACTION",
                resolvedByAction: candidate.actionName,
                resolvedByOutputPath: candidate.outputField.path,
            });
            continue;
        }
        // 3. MISSING — no resolution found
        classified.push({
            fieldPath: field.path,
            fieldTitle: field.title,
            status: "MISSING",
        });
    }
    return classified;
}
// ─── Build dependency graph ───────────────────────────────────────────────────
/**
 * Builds the full DependencyGraph from classified inputs and the set of all
 * available action metadata.
 *
 * Supporting actions are only included when at least one of their outputs is
 * actually needed to resolve a primary-action input.
 */
export function buildDependencyGraph(primaryAction, classifiedInputs, allActions, entityValues) {
    const nodeMap = new Map();
    // Create primary node
    const primaryNode = {
        actionName: primaryAction.summary.label,
        actionId: primaryAction.summary.id,
        kind: "primary",
        directInputs: {},
        provides: [],
        requires: [],
    };
    nodeMap.set(primaryAction.summary.label, primaryNode);
    // Track which supporting actions are needed and what they provide
    const supportingActionNames = new Set();
    for (const ci of classifiedInputs) {
        if (ci.status === "DIRECT" && ci.directValue) {
            primaryNode.directInputs[ci.fieldPath] = ci.directValue;
        }
        if (ci.status === "RESOLVABLE_BY_ACTION" && ci.resolvedByAction && ci.resolvedByOutputPath) {
            supportingActionNames.add(ci.resolvedByAction);
            const mapping = {
                fromAction: ci.resolvedByAction,
                fromPath: ci.resolvedByOutputPath,
                toAction: primaryAction.summary.label,
                toPath: ci.fieldPath,
            };
            primaryNode.requires.push(mapping);
        }
    }
    // For each needed supporting action, classify its own inputs too
    for (const supName of supportingActionNames) {
        const supMeta = allActions.find((a) => a.summary.label === supName || a.summary.name === supName);
        if (!supMeta)
            continue;
        // Determine what direct inputs this supporting action needs from the user
        const supDirectInputs = {};
        for (const inField of supMeta.inputFields) {
            if (!inField.required)
                continue;
            if (isAuthField(inField))
                continue;
            const direct = tryDirectClassify(inField, entityValues);
            if (direct) {
                supDirectInputs[inField.path] = direct.value;
            }
        }
        const supNode = {
            actionName: supMeta.summary.label,
            actionId: supMeta.summary.id,
            kind: "supporting",
            directInputs: supDirectInputs,
            provides: primaryNode.requires.filter((m) => m.fromAction === supName),
            requires: [],
        };
        nodeMap.set(supName, supNode);
    }
    // Topological sort (Kahn's algorithm)
    const executionOrder = topologicalSort(nodeMap, primaryAction.summary.label);
    return {
        nodes: Array.from(nodeMap.values()),
        executionOrder,
    };
}
// ─── Topological sort (Kahn) ──────────────────────────────────────────────────
function topologicalSort(nodeMap, primaryName) {
    // Build in-degree map: number of actions this node depends on
    const inDegree = new Map();
    const dependants = new Map(); // node → nodes that consume its output
    for (const [name, node] of nodeMap) {
        if (!inDegree.has(name))
            inDegree.set(name, 0);
        for (const mapping of node.provides) {
            const target = mapping.toAction;
            inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
            if (!dependants.has(name))
                dependants.set(name, []);
            dependants.get(name).push(target);
        }
    }
    // Nodes with in-degree 0 go first (they have no dependencies)
    const queue = [];
    for (const [name, deg] of inDegree) {
        if (deg === 0 && name !== primaryName)
            queue.push(name);
    }
    // Primary goes last always — push it with zero in-degree so it's last
    if ((inDegree.get(primaryName) ?? 0) === 0) {
        // no supporting actions at all
        if (queue.length === 0)
            queue.push(primaryName);
    }
    const result = [];
    while (queue.length > 0) {
        const current = queue.shift();
        result.push(current);
        for (const dep of dependants.get(current) ?? []) {
            const newDeg = (inDegree.get(dep) ?? 1) - 1;
            inDegree.set(dep, newDeg);
            if (newDeg === 0) {
                if (dep !== primaryName)
                    queue.push(dep);
                else
                    queue.push(dep); // add primary when its deps are satisfied
            }
        }
    }
    // Guarantee primary is at the end
    const withoutPrimary = result.filter((n) => n !== primaryName);
    return [...withoutPrimary, primaryName];
}
