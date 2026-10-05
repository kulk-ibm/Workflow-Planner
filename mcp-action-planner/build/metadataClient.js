/**
 * metadataClient.ts
 *
 * Handles all HTTP communication with the IBM webMethods metadata REST APIs.
 * Implements a two-level cache:
 *   1. In-process LRU-style TTL cache (configurable, default 10 min)
 *   2. Per-analysis request dedup (a single Map passed down the call stack)
 *
 * All API shapes match the examples in Exposed_API/.
 */
import { matchConnectorName, getPinnedAppId } from "./connectorRegistry.js";
// ─── Environment ─────────────────────────────────────────────────────────────
const BASE_URL = (process.env.WMIO_BASE_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.WMIO_API_KEY ?? "";
if (!BASE_URL) {
    throw new Error("WMIO_BASE_URL environment variable is required");
}
if (!API_KEY) {
    throw new Error("WMIO_API_KEY environment variable is required");
}
const CACHE_TTL_MS = parseInt(process.env.METADATA_CACHE_TTL_MS ?? "600000", 10);
class TtlCache {
    store = new Map();
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.data;
    }
    set(key, data) {
        this.store.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    invalidate(keyPrefix) {
        for (const key of this.store.keys()) {
            if (key.startsWith(keyPrefix))
                this.store.delete(key);
        }
    }
}
// Module-level caches (shared across all requests)
const appCache = new TtlCache();
const actionsCache = new TtlCache();
const triggersCache = new TtlCache();
const schemaCache = new TtlCache();
// ─── HTTP helper ─────────────────────────────────────────────────────────────
async function apiGet(path) {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
        headers: {
            "X-INSTANCE-API-KEY": API_KEY,
            "Accept": "application/json",
        },
    });
    if (!res.ok) {
        throw new Error(`API request failed [${res.status}] GET ${url}: ${await res.text()}`);
    }
    return (await res.json());
}
// ─── JSON-Schema field extractor ─────────────────────────────────────────────
/**
 * Recursively flattens a JSON-Schema-style object into a list of SchemaField
 * entries, each carrying its full dot-path (e.g. "cards[].id").
 */
function extractFields(schema, parentPath = "", parentKey = "", isArrayItem = false, requiredKeys = new Set()) {
    const fields = [];
    const properties = schema["properties"];
    if (!properties)
        return fields;
    const schemaRequired = schema["required"] ?? [];
    for (const [key, rawProp] of Object.entries(properties)) {
        const prop = rawProp;
        const fullPath = parentPath ? `${parentPath}.${key}` : key;
        const type = prop["type"] ?? "string";
        const title = prop["title"]
            ?? prop["displayTitle"]
            ?? key;
        const description = prop["description"] ?? "";
        // A field is required if:
        //  a) it appears in the JSON Schema "required" array, OR
        //  b) it has "minLength" >= 1 (IBM webMethods connectors use this convention
        //     instead of a top-level required array)
        const minLength = prop["minLength"];
        const isRequired = schemaRequired.includes(key) ||
            requiredKeys.has(key) ||
            (minLength !== undefined && minLength >= 1);
        // Leaf or union-leaf
        fields.push({
            path: fullPath,
            name: key,
            type,
            title,
            description,
            required: isRequired,
            isArrayItem,
            parentKey,
        });
        // Recurse into nested object
        if (type === "object" && prop["properties"]) {
            fields.push(...extractFields(prop, fullPath, key, isArrayItem, new Set(schemaRequired)));
        }
        // Recurse into array items
        if (type === "array" && prop["items"]) {
            const items = prop["items"];
            if (items["type"] === "object" && items["properties"]) {
                fields.push(...extractFields(items, `${fullPath}[]`, key, true, new Set()));
            }
        }
        // Handle oneOf variants (e.g. Slack channel_type)
        const oneOf = prop["oneOf"];
        if (oneOf) {
            for (const variant of oneOf) {
                if (variant["properties"]) {
                    fields.push(...extractFields(variant, fullPath, key, isArrayItem, new Set()));
                }
            }
        }
    }
    return fields;
}
// ─── Public API ──────────────────────────────────────────────────────────────
/** Parse a raw application record into a ConnectorInfo. */
function parseConnectorInfo(raw) {
    const capabilities = raw["capabilities"] ?? {};
    const interactionTypes = (capabilities["interactionTypes"] ?? []).filter((t) => t === "actions" || t === "triggers");
    const effectiveTypes = interactionTypes.length > 0 ? interactionTypes : ["actions"];
    return {
        id: raw["id"],
        name: raw["name"],
        label: raw["label"],
        description: raw["description"] ?? "",
        interactionTypes: effectiveTypes,
    };
}
/**
 * GET /apis/v2/rest/applications/{name}
 *
 * When the API returns multiple records with the same name (e.g. Box has 3),
 * pick the first one whose interactionTypes includes "actions". If none qualify,
 * fall back to the first record. This ensures the connector used for action
 * resolution is actually action-capable.
 */
export async function getConnector(nameHint) {
    const cacheKey = `connector:${nameHint.toLowerCase()}`;
    const cached = appCache.get(cacheKey);
    if (cached)
        return cached;
    // If a pinned appId exists in connectors.json, try to fetch that app directly.
    // If the pinned ID is not found on this environment, fall through to name-based search.
    const pinnedId = getPinnedAppId(nameHint);
    if (pinnedId) {
        try {
            const data = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(pinnedId)}`);
            const arr = (Array.isArray(data) ? data : [data]);
            if (arr.length) {
                const connector = parseConnectorInfo(arr[0]);
                appCache.set(cacheKey, connector);
                appCache.set(`connector:${pinnedId.toLowerCase()}`, connector);
                return connector;
            }
            // arr is empty — fall through to name-based search below
        }
        catch {
            // Pinned ID not available on this environment — fall through to name-based search
        }
    }
    // Match hint against connectors.json to get the canonical spelling
    const registeredName = matchConnectorName(nameHint);
    const lookupName = registeredName ?? nameHint;
    const data = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(lookupName)}`);
    // The API returns either an array (search by name) or a single object
    const arr = (Array.isArray(data) ? data : [data]);
    if (!arr.length)
        throw new Error(`Connector "${nameHint}" not found`);
    const all = arr.map(parseConnectorInfo);
    // Prefer the first entry that has "actions" capability; fallback to arr[0]
    const connector = all.find((c) => c.interactionTypes.includes("actions")) ?? all[0];
    // Merge interactionTypes from all records so trigger-capable variants are
    // not lost when the primary connector was chosen for its "actions" capability.
    const mergedTypes = Array.from(new Set(all.flatMap((c) => c.interactionTypes)));
    const mergedConnector = { ...connector, interactionTypes: mergedTypes };
    // If no record has "triggers" but another has a distinct ID that does,
    // also store the trigger-capable record's ID so getTriggers uses the right endpoint.
    const triggerRecord = all.find((c) => c.interactionTypes.includes("triggers"));
    if (triggerRecord && triggerRecord.id !== connector.id) {
        mergedConnector.triggerId = triggerRecord.id;
    }
    // Cache under both the hint and the canonical name
    appCache.set(cacheKey, mergedConnector);
    if (registeredName) {
        appCache.set(`connector:${registeredName.toLowerCase()}`, mergedConnector);
    }
    return mergedConnector;
}
/**
 * Returns ALL action-capable ConnectorInfo records for a name hint.
 *
 * Always performs the name-based multi-record search so every platform app
 * record for this connector is included (e.g. Asana, Slack, Box each have
 * multiple UUIDs on some environments). If a pinned appId is set in
 * connectors.json AND it is not already in the name-based results, it is
 * appended as an extra source so its actions are also fetched and merged.
 *
 * This ensures rankActionsByIntent scores against the full combined action
 * catalogue regardless of how many platform records a connector has.
 */
export async function getAllActionConnectors(nameHint) {
    const cacheKey = `all-connectors:${nameHint.toLowerCase()}`;
    const cached = appCache.get(cacheKey);
    if (cached)
        return cached;
    const registeredName = matchConnectorName(nameHint);
    const lookupName = registeredName ?? nameHint;
    // ── Name-based search: returns all platform records for this connector ──
    const data = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(lookupName)}`);
    const arr = (Array.isArray(data) ? data : [data]);
    const all = arr.map(parseConnectorInfo);
    const actionCapable = all.filter((c) => c.interactionTypes.includes("actions"));
    const fromName = actionCapable.length > 0 ? actionCapable : all.slice(0, 1);
    // ── Pinned ID: if set and not already in the name results, include it ──
    // Some connectors have a well-known stable app ID (e.g. "wm.box") whose
    // /actions endpoint returns actions not present on any UUID record. The
    // application-lookup endpoint may return [] for the pinned ID on some
    // environments, so we represent it as a synthetic stub with kind "actions"
    // so getActions(pinnedId) is called during the merge in loadConnectorContext.
    const pinnedId = getPinnedAppId(nameHint);
    const alreadyIncluded = fromName.some((c) => c.id === pinnedId);
    const fromPinned = pinnedId && !alreadyIncluded
        ? [
            {
                id: pinnedId,
                name: lookupName,
                label: lookupName,
                description: "",
                interactionTypes: ["actions"],
            },
        ]
        : [];
    const result = [...fromName, ...fromPinned];
    appCache.set(cacheKey, result);
    return result;
}
/**
 * Backward-compatible wrapper — returns a plain Application.
 * Used by parts of the codebase that only need id/name/label.
 */
export async function getApplication(nameHint) {
    const c = await getConnector(nameHint);
    return { id: c.id, name: c.name, label: c.label, description: c.description };
}
// ─── Actions ──────────────────────────────────────────────────────────────────
/**
 * GET /apis/v2/rest/applications/{appId}/actions
 *
 * Only call this when interactionTypes includes "actions".
 */
export async function getActions(appId) {
    const cacheKey = `actions:${appId}`;
    const cached = actionsCache.get(cacheKey);
    if (cached)
        return cached;
    const data = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(appId)}/actions`);
    const rawActions = data["actions"] ??
        (Array.isArray(data) ? data : []);
    const actions = rawActions.map((a) => ({
        id: a["id"],
        name: a["name"],
        label: a["label"] ?? a["name"],
        description: a["description"] ?? "",
    }));
    actionsCache.set(cacheKey, actions);
    return actions;
}
/**
 * GET /apis/v2/rest/applications/{appId}/actions/{actionId}/describe/input
 */
export async function getActionInputSchema(appId, actionId) {
    const cacheKey = `action-input:${appId}:${actionId}`;
    const cached = schemaCache.get(cacheKey);
    if (cached)
        return cached;
    const schema = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(appId)}/actions/${encodeURIComponent(actionId)}/describe/input`);
    const required = new Set(schema["required"] ?? []);
    const fields = extractFields(schema, "", "", false, required);
    schemaCache.set(cacheKey, fields);
    return fields;
}
/**
 * GET /apis/v2/rest/applications/{appId}/actions/{actionId}/describe/output
 */
export async function getActionOutputSchema(appId, actionId) {
    const cacheKey = `action-output:${appId}:${actionId}`;
    const cached = schemaCache.get(cacheKey);
    if (cached)
        return cached;
    const schema = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(appId)}/actions/${encodeURIComponent(actionId)}/describe/output`);
    const fields = extractFields(schema, "", "", false, new Set());
    schemaCache.set(cacheKey, fields);
    return fields;
}
// ─── Triggers ─────────────────────────────────────────────────────────────────
/**
 * GET /apis/v2/rest/applications/{appId}/triggers
 *
 * Only call this when interactionTypes includes "triggers".
 */
export async function getTriggers(appId) {
    const cacheKey = `triggers:${appId}`;
    const cached = triggersCache.get(cacheKey);
    if (cached)
        return cached;
    const data = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(appId)}/triggers`);
    const rawTriggers = data["triggers"] ??
        (Array.isArray(data) ? data : []);
    const triggers = rawTriggers.map((t) => ({
        id: t["id"],
        name: t["name"],
        label: t["label"] ?? t["name"],
        description: t["description"] ?? "",
    }));
    triggersCache.set(cacheKey, triggers);
    return triggers;
}
/**
 * GET /apis/v2/rest/applications/{appId}/triggers/{triggerId}/describe/input
 */
export async function getTriggerInputSchema(appId, triggerId) {
    const cacheKey = `trigger-input:${appId}:${triggerId}`;
    const cached = schemaCache.get(cacheKey);
    if (cached)
        return cached;
    const schema = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(appId)}/triggers/${encodeURIComponent(triggerId)}/describe/input`);
    const fields = extractFields(schema, "", "", false, new Set());
    schemaCache.set(cacheKey, fields);
    return fields;
}
/**
 * GET /apis/v2/rest/applications/{appId}/triggers/{triggerId}/describe/output
 */
export async function getTriggerOutputSchema(appId, triggerId) {
    const cacheKey = `trigger-output:${appId}:${triggerId}`;
    const cached = schemaCache.get(cacheKey);
    if (cached)
        return cached;
    const schema = await apiGet(`/apis/v2/rest/applications/${encodeURIComponent(appId)}/triggers/${encodeURIComponent(triggerId)}/describe/output`);
    const fields = extractFields(schema, "", "", false, new Set());
    schemaCache.set(cacheKey, fields);
    return fields;
}
// ─── Cache invalidation ───────────────────────────────────────────────────────
/** Force-invalidate all cached data for a given application. */
export function invalidateApplicationCache(appId) {
    schemaCache.invalidate(`action-input:${appId}`);
    schemaCache.invalidate(`action-output:${appId}`);
    schemaCache.invalidate(`trigger-input:${appId}`);
    schemaCache.invalidate(`trigger-output:${appId}`);
    actionsCache.invalidate(`actions:${appId}`);
    triggersCache.invalidate(`triggers:${appId}`);
}
