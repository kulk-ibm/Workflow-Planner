/**
 * requestAnalyzer.ts
 *
 * Orchestrates the full analysis pipeline for a single natural-language request.
 *
 * Supports four request modes:
 *
 *  A) ACTION-ONLY        — "Add Green label to card ABC in Trello"
 *  B) TRIGGER-DRIVEN     — "when a new board is created in Trello, add label to card"
 *  C) MULTI-ACTION       — "when a board is updated in Trello, delete card … and add label …"
 *  D) MULTI-APPLICATION  — "when new task is created in Asana … send message on Slack … and publish on AMQP"
 *     Each action sub-clause targets its own connector; resolved independently and merged.
 */
import { getConnector, getAllActionConnectors, getActions, getActionInputSchema, getActionOutputSchema, getTriggers, getTriggerInputSchema, getTriggerOutputSchema, } from "./metadataClient.js";
import { rankActionsByIntent, tokenize } from "./schemaMatcher.js";
import { listConnectorNames } from "./connectorRegistry.js";
import { buildDependencyGraph, classifyInputs, } from "./dependencyResolver.js";
import { buildAnalysisResult } from "./planFormatter.js";
// ─── Natural-language entity extraction ──────────────────────────────────────
/**
 * Detect trigger-driven requests.
 *
 * Returns the "trigger clause" (e.g. "a new board is created") and the
 * "action clause" (e.g. "add label to card in board b15") when the request
 * follows a "when … , do …" pattern.
 */
export function parseTriggerPattern(request) {
    // Action-starter verbs used to detect the boundary between trigger and action clauses
    const actionStarterVerbs = [
        "add", "create", "update", "delete", "remove", "rename", "move", "copy",
        "archive", "unarchive", "invite", "post", "send", "get", "search",
        "list", "fetch", "assign", "attach", "detach", "set", "close", "resolve",
        "acknowledge", "accept", "decline", "publish",
    ];
    const verbAlternation = actionStarterVerbs.join("|");
    // Patterns (evaluated in order — most specific first):
    //  1. "when X then Y"   — explicit "then" separator (no comma needed)
    //  2. "when X, Y"       — comma separator
    //  3. "if X then Y"
    //  4. "on X, Y"
    //  5. "when X <verb> …" — no separator, action clause starts with a known verb
    const triggerPrefixes = [
        /^when(?:ever)?\s+(.+?)\s+then\s+(.+)$/i,
        /^when(?:ever)?\s+(.+?)\s*,\s*(.+)$/i,
        /^if\s+(.+?)\s+then\s+(.+)$/i,
        /^on\s+(.+?)\s*,\s*(.+)$/i,
        new RegExp(`^when(?:ever)?\\s+(.+?)\\s+(${verbAlternation})\\s+(.+)$`, "i"),
    ];
    for (let i = 0; i < triggerPrefixes.length; i++) {
        const m = request.match(triggerPrefixes[i]);
        if (m) {
            // Pattern 5 (verb-boundary, index 4) has 3 capture groups:
            // m[1] = trigger clause, m[2] = action verb, m[3] = rest of action clause
            const isVerbBoundary = i === triggerPrefixes.length - 1;
            return {
                isTriggerDriven: true,
                triggerClause: m[1].trim(),
                actionClause: isVerbBoundary
                    ? `${m[2].trim()} ${m[3].trim()}` // re-attach the verb to the action clause
                    : m[2].trim(),
            };
        }
    }
    return { isTriggerDriven: false, triggerClause: "", actionClause: request };
}
/**
 * Simple heuristic NL extractor.
 *
 * Finds:
 *  - The application name (last word after "in " / "on " / "using " / "via ")
 *  - Quoted entity values (e.g. card "ABC")
 *  - Unquoted capitalized/alphanumeric entity values following known entity markers
 *  - "adjective + noun" values (e.g. "Green label")
 *
 * Returns:
 *  - applicationHint: the identified application name
 *  - intentTokens:    tokens that describe the user's intent (verb + object)
 *  - entityValues:    Map<entityNoun, value>
 */
export function parseRequest(clauseOrRequest) {
    const entityValues = new Map();
    // ── 1. Extract application name directly from connectors.json ────────────
    // Scan every registered connector name against the clause text.
    // The first connector name found (by registry order) is used as the
    // application hint — no regex required.
    const registeredNames = listConnectorNames();
    const clauseLower = clauseOrRequest.toLowerCase();
    // Sort longer names first so "Microsoft Office 365" is matched before "Microsoft"
    const sortedNames = [...registeredNames].sort((a, b) => b.length - a.length);
    const applicationHint = sortedNames.find((n) => clauseLower.includes(n.toLowerCase())) ?? "";
    // Remove the connector name from the clause so it doesn't pollute intent tokens
    const withoutApp = applicationHint
        ? clauseOrRequest.replace(new RegExp(applicationHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ").trim()
        : clauseOrRequest;
    // ── 2. Quoted entity values: card "ABC", board 'b15', list "todo"
    const quotedPattern = /\b(card|list|board|task|issue|ticket|item|record)\s+["""']([^"""']+)["""']/gi;
    let m;
    while ((m = quotedPattern.exec(withoutApp)) !== null) {
        entityValues.set(m[1].toLowerCase(), m[2].trim());
    }
    // ── 3. Unquoted entity identifier: "card ABC", "board b15", "card named ABC"
    // Matches alphanumeric identifiers (allows lowercase like "b15")
    const unquotedEntityPattern = /\b(card|list|board|task|issue|ticket)\s+(?:named\s+)?([A-Za-z0-9_\-]+)\b/g;
    while ((m = unquotedEntityPattern.exec(withoutApp)) !== null) {
        // Skip if value looks like a stop word
        const val = m[2].trim();
        const stopWords = new Set(["a", "an", "the", "in", "on", "with", "of", "is", "was", "be"]);
        if (!stopWords.has(val.toLowerCase())) {
            entityValues.set(m[1].toLowerCase(), val);
        }
    }
    // ── 4. "adjective + noun" patterns: "Green label", "High priority"
    const adjectiveEntityPattern = /\b([A-Z][a-z]+)\s+(label|tag|category|status|priority|type|color|colour)\b/g;
    while ((m = adjectiveEntityPattern.exec(clauseOrRequest)) !== null) {
        entityValues.set(m[2].toLowerCase(), m[1].trim());
    }
    // ── 5. Intent tokens
    // Note: event verbs ("created","updated","deleted") are intentionally kept so
    // that trigger matching can distinguish New/Update/Delete triggers.
    const stopWords = new Set([
        "a", "an", "the", "to", "in", "on", "using", "via", "for", "with",
        "of", "from", "into", "at", "by", "and", "or", "but", "when", "whenever",
        "if", "then", "is", "are", "was", "be",
    ]);
    const intentTokens = tokenize(withoutApp).filter((t) => !stopWords.has(t));
    return { applicationHint, intentTokens, entityValues };
}
// ─── Metadata loading ─────────────────────────────────────────────────────────
/**
 * How many non-primary actions to fetch schemas for.
 * The actions are pre-ranked by intent before fetching, so the top-N covers
 * the most relevant candidates without hammering the API for every action.
 */
const MAX_SUPPORTING_CANDIDATES = parseInt(process.env.MAX_SUPPORTING_CANDIDATES ?? "15", 10);
async function loadActionMetadata(appId, action) {
    const [inputFields, outputFields] = await Promise.all([
        getActionInputSchema(appId, action.id),
        getActionOutputSchema(appId, action.id),
    ]);
    return { summary: action, inputFields, outputFields };
}
async function loadTriggerMetadata(appId, trigger) {
    const [inputFields, outputFields] = await Promise.all([
        getTriggerInputSchema(appId, trigger.id),
        getTriggerOutputSchema(appId, trigger.id),
    ]);
    return { summary: trigger, inputFields, outputFields };
}
// ─── Multi-action clause splitter ────────────────────────────────────────────
/**
 * Split a compound action clause like:
 *   "delete card in trello in card Customer Survey App and add label to card in trello label it green"
 * into individual sub-clauses:
 *   ["delete card in trello in card Customer Survey App",
 *    "add label to card in trello label it green"]
 *
 * Only splits on " and " boundaries that appear to separate distinct action
 * intents (i.e. the text after " and " starts with a verb or action keyword).
 */
function splitActionClauses(actionClause) {
    // Action-starter verbs — a split is only made when the segment after "and"
    // begins with one of these (case-insensitive).
    const actionVerbs = [
        "add", "create", "update", "delete", "remove", "rename", "move", "copy",
        "archive", "unarchive", "invite", "post", "send", "get", "search",
        "list", "fetch", "assign", "attach", "detach", "set", "close", "resolve",
        "acknowledge", "accept", "decline",
    ];
    // Split on " and " (case-insensitive), then re-join any segments that don't
    // start with an action verb back to the previous segment.
    const rawParts = actionClause.split(/\s+and\s+/i);
    const clauses = [];
    for (const part of rawParts) {
        const firstWord = part.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const isNewAction = actionVerbs.includes(firstWord);
        if (clauses.length === 0 || isNewAction) {
            clauses.push(part.trim());
        }
        else {
            // Continuation of the previous clause (e.g. "and list To Do")
            clauses[clauses.length - 1] += " and " + part.trim();
        }
    }
    return clauses.filter(Boolean);
}
// ─── Single-action resolver (shared context) ─────────────────────────────────
/**
 * Resolve ONE action sub-clause given an already-loaded connector + action pool.
 * Returns the same shape as buildAnalysisResult so individual plans can be merged.
 */
async function resolveOneAction(actionSubClause, connector, actionSummaries, resolvedTriggerMeta, entityValues, supportingPool // pre-loaded schema pool for all candidates
) {
    const clauseParsed = parseRequest(actionSubClause);
    // Merge entity values extracted from this sub-clause into the global map
    const mergedEntities = new Map([...entityValues, ...clauseParsed.entityValues]);
    const intentTokens = clauseParsed.intentTokens;
    // ── Identify primary action ──────────────────────────────────────────────
    const rankedActions = rankActionsByIntent(intentTokens, actionSummaries);
    const primaryActionSummary = rankedActions[0];
    if (!primaryActionSummary) {
        const issue = `No matching action found in "${connector.name}" for: "${actionSubClause}"`;
        return {
            status: "error",
            application: { name: connector.name, appId: connector.id },
            request: actionSubClause,
            primaryAction: null,
            classifiedInputs: [],
            executionPlan: [],
            issues: [issue],
            humanReadable: `Request:\n${actionSubClause}\n\nIssues:\n  ⚠ ${issue}\n`,
        };
    }
    // ── Build supporting candidate pool ─────────────────────────────────────
    // Use the pre-loaded pool, excluding the primary action itself.
    let allSupportingCandidates = supportingPool.filter((m) => m.summary.id !== primaryActionSummary.id);
    if (resolvedTriggerMeta) {
        const triggerAsAction = {
            summary: {
                id: resolvedTriggerMeta.summary.id,
                name: resolvedTriggerMeta.summary.name,
                label: resolvedTriggerMeta.summary.label,
                description: resolvedTriggerMeta.summary.description,
            },
            inputFields: [],
            outputFields: resolvedTriggerMeta.outputFields,
        };
        allSupportingCandidates = [triggerAsAction, ...allSupportingCandidates];
    }
    // Ensure primaryActionMeta is in the pool (may not be if it was a data-source itself).
    // Use the actionOwnerMap (if available) to fetch from the correct app ID.
    let primaryActionMeta = supportingPool.find((m) => m.summary.id === primaryActionSummary.id);
    if (!primaryActionMeta) {
        const ownerAppId = connector
            .actionOwnerMap?.get(primaryActionSummary.id) ?? connector.id;
        primaryActionMeta = await loadActionMetadata(ownerAppId, primaryActionSummary);
    }
    // ── Classify + graph ────────────────────────────────────────────────────
    const classifiedInputs = classifyInputs(primaryActionMeta.inputFields, mergedEntities, allSupportingCandidates, primaryActionMeta.summary.label);
    const graph = buildDependencyGraph(primaryActionMeta, classifiedInputs, allSupportingCandidates, mergedEntities);
    const issues = [];
    for (const mi of classifiedInputs.filter((ci) => ci.status === "MISSING")) {
        issues.push(`Required input "${mi.fieldTitle}" (${mi.fieldPath}) cannot be resolved. Additional user input is required.`);
    }
    for (const ai of classifiedInputs.filter((ci) => ci.status === "AMBIGUOUS")) {
        issues.push(`Multiple candidates found for "${ai.fieldTitle}" (${ai.fieldPath}). Additional information is required.`);
    }
    const status = classifiedInputs.some((ci) => ci.status === "MISSING")
        ? "unresolvable"
        : classifiedInputs.some((ci) => ci.status === "AMBIGUOUS")
            ? "ambiguous"
            : "resolvable";
    return buildAnalysisResult({
        request: actionSubClause,
        app: connector,
        triggerMeta: resolvedTriggerMeta ?? undefined,
        primaryActionMeta,
        classifiedInputs,
        graph,
        issues,
        status,
        allSupportingCandidates,
        entityValues: mergedEntities,
    });
}
// ─── Multi-plan merger ────────────────────────────────────────────────────────
/**
 * Merge multiple single-action AnalysisResults (one per action sub-clause) into
 * one combined AnalysisResult with a unified execution plan.
 *
 * De-duplicates shared supporting actions (e.g. Search Cards appears once even
 * if both Delete Card and Add Label to Card depend on it), renumbers steps, and
 * collects all classified inputs and issues.
 */
function mergePlans(request, results, connector, triggerName, triggerId) {
    // Combine status: worst-case wins
    const statusPriority = {
        resolvable: 0, ambiguous: 1, unresolvable: 2, error: 3,
    };
    const mergedStatus = results.reduce((worst, r) => statusPriority[r.status] > statusPriority[worst] ? r.status : worst, "resolvable");
    const allIssues = results.flatMap((r) => r.issues);
    const allClassifiedInputs = results.flatMap((r) => r.classifiedInputs);
    // Build a merged execution plan:
    //  1. Trigger step (once, from first result that has it)
    //  2. Supporting steps deduplicated by actionId
    //  3. Primary action steps (one per sub-clause, in order)
    const triggerStep = results
        .flatMap((r) => r.executionPlan)
        .find((s) => s.kind === "trigger");
    // Collect all non-trigger, non-primary steps (supporting actions)
    const seenSupportingIds = new Set();
    const supportingSteps = [];
    for (const result of results) {
        // The last step in each plan is the primary action — everything before is supporting
        const planSteps = result.executionPlan.filter((s) => s.kind !== "trigger");
        const supportingInPlan = planSteps.slice(0, -1);
        for (const step of supportingInPlan) {
            if (!seenSupportingIds.has(step.actionId)) {
                seenSupportingIds.add(step.actionId);
                supportingSteps.push(step);
            }
            else {
                // Already included — but merge its outputs map so both primary actions
                // are listed as consumers of this supporting step.
                const existing = supportingSteps.find((s) => s.actionId === step.actionId);
                existing.outputs = { ...(existing.outputs ?? {}), ...(step.outputs ?? {}) };
            }
        }
    }
    // Primary action steps (one per result, deduplicated by actionId)
    const seenPrimaryIds = new Set();
    const primarySteps = [];
    for (const result of results) {
        const planSteps = result.executionPlan.filter((s) => s.kind !== "trigger");
        const primaryStep = planSteps[planSteps.length - 1];
        if (primaryStep && !seenPrimaryIds.has(primaryStep.actionId)) {
            seenPrimaryIds.add(primaryStep.actionId);
            primarySteps.push(primaryStep);
        }
    }
    // Assemble and renumber
    const rawPlan = [
        ...(triggerStep ? [triggerStep] : []),
        ...supportingSteps,
        ...primarySteps,
    ];
    const numberedPlan = rawPlan.map((s, i) => ({ ...s, step: i + 1 }));
    // Build human-readable
    const lines = [];
    lines.push(`Request:\n${request}\n`);
    if (allIssues.length) {
        lines.push("Issues:");
        for (const issue of allIssues)
            lines.push(`  ⚠ ${issue}`);
        lines.push("");
    }
    lines.push("Plan:\n");
    for (const step of numberedPlan) {
        const kindLabel = step.kind === "trigger" ? " [TRIGGER]" : "";
        lines.push(`${step.step}.${kindLabel} ${step.action}`);
        if (step.purpose)
            lines.push(`   └─ ${step.purpose}`);
        const directEntries = Object.entries(step.inputs).filter(([, v]) => !v.includes("."));
        if (directEntries.length > 0) {
            lines.push("\n   Inputs from request:");
            for (const [k, v] of directEntries)
                lines.push(`   ├─ ${k} = "${v}"`);
        }
        const resolvedEntries = Object.entries(step.inputs).filter(([, v]) => v.includes("."));
        if (resolvedEntries.length > 0) {
            lines.push("\n   Inputs:");
            resolvedEntries.forEach(([k, v], idx) => {
                const branch = idx === resolvedEntries.length - 1 ? "└─" : "├─";
                lines.push(`   ${branch} ${k} ← ${v}`);
            });
        }
        if (step.outputs && Object.keys(step.outputs).length > 0) {
            lines.push("\n   Provides:");
            const outEntries = Object.entries(step.outputs);
            outEntries.forEach(([k, v], idx) => {
                const branch = idx === outEntries.length - 1 ? "└─" : "├─";
                lines.push(`   ${branch} ${k} → ${v}`);
            });
        }
        lines.push("");
    }
    // Multiple primary actions — report first one in the primaryAction field,
    // full list visible in the execution plan.
    const firstPrimary = results[0].primaryAction;
    return {
        status: mergedStatus,
        application: { name: connector.name, appId: connector.id },
        request,
        ...(triggerName && triggerId ? { triggerAction: { name: triggerName, triggerId } } : {}),
        primaryAction: firstPrimary,
        classifiedInputs: allClassifiedInputs,
        executionPlan: numberedPlan,
        issues: allIssues,
        humanReadable: lines.join("\n"),
    };
}
// ─── Multi-application helpers ────────────────────────────────────────────────
/**
 * Scan text against the connector registry and return all canonical names found,
 * in the order they first appear in the text.
 * Longer names are checked first to avoid "Microsoft" matching before "Microsoft Teams".
 */
function scanConnectorNames(text) {
    const textLower = text.toLowerCase();
    // Sort longer names first so multi-word names win over partial matches
    const sorted = [...listConnectorNames()].sort((a, b) => b.length - a.length);
    const found = [];
    for (const name of sorted) {
        if (textLower.includes(name.toLowerCase()) && !found.includes(name)) {
            found.push(name);
        }
    }
    return found;
}
/**
 * Given a sub-clause and a list of candidate connector names (in priority order),
 * return the connector name explicitly present in the sub-clause,
 * or fall back to the first candidate.
 */
function assignSubClauseConnector(subClause, candidates) {
    const lower = subClause.toLowerCase();
    // Longer names first so "Microsoft Teams" beats "Microsoft"
    const sorted = [...candidates].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
        if (lower.includes(name.toLowerCase()))
            return name;
    }
    return candidates[0];
}
async function loadConnectorContext(nameHint, overallIntentTokens) {
    // Primary connector (used for trigger resolution + as the representative app)
    const connector = await getConnector(nameHint);
    // Fetch ALL action-capable app IDs for this name (e.g. Box has 3 entries,
    // 2 of which have interactionTypes: ["actions"]). Merge their action lists
    // so no actions are missed just because they live in a different app record.
    const allActionConnectors = await getAllActionConnectors(nameHint);
    const actionArrays = await Promise.all(allActionConnectors.map((c) => c.interactionTypes.includes("actions")
        ? getActions(c.id)
        : Promise.resolve([])));
    // Deduplicate by action id — keep the first occurrence and track which
    // app ID owns each action so schema fetches go to the right endpoint.
    const actionOwnerMap = new Map(); // actionId → appId
    const seen = new Set();
    const actionSummaries = [];
    for (let i = 0; i < allActionConnectors.length; i++) {
        for (const a of actionArrays[i]) {
            if (!seen.has(a.id)) {
                seen.add(a.id);
                actionSummaries.push(a);
                actionOwnerMap.set(a.id, allActionConnectors[i].id);
            }
        }
    }
    // Triggers come from the primary connector only
    const triggerSummaries = connector.interactionTypes.includes("triggers")
        ? await getTriggers(connector.id).catch(() => [])
        : [];
    const dataSourcePrefixes = ["search", "get", "list", "find", "fetch", "lookup", "query"];
    const dataSourceSummaries = actionSummaries.filter((a) => dataSourcePrefixes.some((p) => a.label.toLowerCase().startsWith(p)));
    const topByIntent = rankActionsByIntent(overallIntentTokens, actionSummaries)
        .slice(0, MAX_SUPPORTING_CANDIDATES);
    const candidateSet = new Map();
    for (const a of [...topByIntent, ...dataSourceSummaries])
        candidateSet.set(a.id, a);
    // Load schemas using the correct owner app ID for each action
    const sharedPool = await Promise.all([...candidateSet.values()].map((a) => {
        const ownerAppId = actionOwnerMap.get(a.id) ?? connector.id;
        return loadActionMetadata(ownerAppId, a);
    }));
    // Patch connector to expose merged action owner map for resolveOneAction
    const mergedConnector = {
        ...connector,
        actionOwnerMap,
    };
    return { connector: mergedConnector, actionSummaries, triggerSummaries, sharedPool };
}
// ─── Main analysis entry point ────────────────────────────────────────────────
export async function analyzeRequest(request) {
    // ── Step 1: Detect trigger-driven vs action-only and split clauses ────────
    const { isTriggerDriven, triggerClause, actionClause } = parseTriggerPattern(request);
    const actionParsed = parseRequest(actionClause);
    const triggerParsed = isTriggerDriven ? parseRequest(triggerClause) : actionParsed;
    // ── Step 2: Identify connectors from registry scan (no regex) ────────────
    // parseRequest already scanned each clause against connectors.json — use
    // those results directly.  Fall back to a full-request scan if both are empty.
    const triggerClauseConnectors = isTriggerDriven
        ? (triggerParsed.applicationHint ? [triggerParsed.applicationHint] : scanConnectorNames(triggerClause))
        : [];
    const actionClauseConnectors = actionParsed.applicationHint
        ? [actionParsed.applicationHint, ...scanConnectorNames(actionClause).filter(n => n !== actionParsed.applicationHint)]
        : scanConnectorNames(actionClause);
    const allConnectorNames = scanConnectorNames(request);
    // Trigger connector: prefer the hint already extracted from the trigger clause,
    // then the first connector found in the trigger clause, then action clause, then anywhere.
    const triggerConnectorName = triggerClauseConnectors[0]
        ?? actionClauseConnectors[0]
        ?? allConnectorNames[0]
        ?? "";
    if (!triggerConnectorName) {
        return {
            status: "error",
            application: { name: "", appId: "" },
            request,
            primaryAction: null,
            classifiedInputs: [],
            executionPlan: [],
            issues: ["Could not identify any application from the request. Please name at least one connector (e.g. 'in Trello', 'on Slack')."],
            humanReadable: "Error: Could not identify any application name from the request.",
        };
    }
    // ── Step 3: Split action clause into individual sub-clauses ──────────────
    const actionSubClauses = splitActionClauses(actionClause);
    // ── Step 4: Load connector contexts for every unique connector mentioned ──
    // Route each sub-clause to its own connector by scanning the sub-clause text.
    // Fallback chain: action clause connectors → all request connectors → trigger connector.
    const routingCandidates = actionClauseConnectors.length > 0 ? actionClauseConnectors :
        allConnectorNames.length > 0 ? allConnectorNames :
            [triggerConnectorName];
    const subClauseConnectorNames = actionSubClauses.map((sc) => assignSubClauseConnector(sc, routingCandidates));
    const uniqueConnectorNames = [
        triggerConnectorName,
        ...subClauseConnectorNames,
    ].filter((v, i, arr) => arr.indexOf(v) === i);
    const overallTokens = actionParsed.intentTokens;
    const contextMap = new Map();
    const contextLoadResults = await Promise.allSettled(uniqueConnectorNames.map(async (name) => {
        try {
            const ctx = await loadConnectorContext(name, overallTokens);
            contextMap.set(name, ctx);
        }
        catch (err) {
            throw new Error(`Connector "${name}" could not be loaded: ${String(err)}`);
        }
    }));
    // Report any connectors that failed to load
    const loadErrors = contextLoadResults
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason));
    if (loadErrors.length === uniqueConnectorNames.length) {
        return {
            status: "error",
            application: { name: triggerConnectorName, appId: "" },
            request,
            primaryAction: null,
            classifiedInputs: [],
            executionPlan: [],
            issues: loadErrors,
            humanReadable: `Error: ${loadErrors.join("; ")}`,
        };
    }
    // ── Step 5: Load trigger from trigger-connector ───────────────────────────
    const triggerCtx = contextMap.get(triggerConnectorName);
    let resolvedTriggerMeta = null;
    if (isTriggerDriven && triggerCtx && triggerCtx.triggerSummaries.length > 0) {
        const triggerIntentTokens = triggerParsed.intentTokens.length
            ? triggerParsed.intentTokens
            : tokenize(triggerClause);
        const rankedTriggers = rankActionsByIntent(triggerIntentTokens, triggerCtx.triggerSummaries);
        resolvedTriggerMeta = await loadTriggerMetadata(triggerCtx.connector.id, rankedTriggers[0]);
    }
    // ── Step 6: Resolve global entity values ─────────────────────────────────
    const globalEntityValues = new Map([
        ...triggerParsed.entityValues,
        ...actionParsed.entityValues,
    ]);
    // ── Step 7: Resolve each action sub-clause against its connector ──────────
    const subResults = await Promise.all(actionSubClauses.map((subClause, idx) => {
        const connName = subClauseConnectorNames[idx];
        const ctx = contextMap.get(connName) ?? triggerCtx;
        if (!ctx) {
            // Fallback error result for this sub-clause
            return Promise.resolve({
                status: "error",
                application: { name: connName, appId: "" },
                request: subClause,
                primaryAction: null,
                classifiedInputs: [],
                executionPlan: [],
                issues: [`Connector "${connName}" could not be loaded.`],
                humanReadable: `Error: Connector "${connName}" could not be loaded.`,
            });
        }
        return resolveOneAction(subClause, ctx.connector, ctx.actionSummaries, resolvedTriggerMeta, globalEntityValues, ctx.sharedPool);
    }));
    // ── Step 8: Merge into one result ─────────────────────────────────────────
    // Use trigger connector as the "primary" application in the merged result.
    const primaryConnector = triggerCtx?.connector ?? contextMap.values().next().value.connector;
    if (subResults.length === 1) {
        return { ...subResults[0], request };
    }
    return mergePlans(request, subResults, primaryConnector, resolvedTriggerMeta?.summary.label, resolvedTriggerMeta?.summary.id);
}
