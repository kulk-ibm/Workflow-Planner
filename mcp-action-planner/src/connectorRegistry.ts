/**
 * connectorRegistry.ts
 *
 * Loads the plain connector-name list from connectors.json and exposes one helper:
 *
 *  matchConnectorName(hint)
 *    Given a word or phrase from a natural-language request (e.g. "trello",
 *    "Slack", "microsoft teams"), returns the matching registered connector name
 *    exactly as it appears in the list (e.g. "Trello", "Slack", "Microsoft Teams"),
 *    or null when no entry matches closely enough.
 *
 * The matched name is then used as the path parameter in:
 *   GET /apis/v2/rest/applications/<connectorName>
 *
 * Format of connectors.json:
 *   { "connectors": ["Trello", "Slack", "Microsoft Teams", ...] }
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Load the name list ───────────────────────────────────────────────────────

/** Each entry in connectors.json is either a plain name string or an object with an optional pinned appId. */
interface ConnectorEntry {
  name: string;
  /** When set, use this exact platform app ID instead of searching by name. */
  appId?: string;
}

interface ConnectorFile {
  connectors: Array<string | ConnectorEntry>;
}

interface Registry {
  names: string[];
  /** name (lowercased) → pinned appId */
  appIds: Map<string, string>;
}

function loadRegistry(): Registry {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(__dirname, "..", "connectors.json");
  const filePath = process.env.CONNECTORS_FILE
    ? resolve(process.env.CONNECTORS_FILE)
    : defaultPath;

  if (!existsSync(filePath)) {
    console.error(
      `[connector-registry] connectors.json not found at ${filePath}. ` +
      `All connector names will be resolved directly via the API.`
    );
    return { names: [], appIds: new Map() };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ConnectorFile;
    const names: string[] = [];
    const appIds = new Map<string, string>();

    for (const entry of parsed.connectors ?? []) {
      if (typeof entry === "string") {
        if (entry.trim()) names.push(entry.trim());
      } else if (entry && typeof entry.name === "string" && entry.name.trim()) {
        const name = entry.name.trim();
        names.push(name);
        if (entry.appId && entry.appId.trim()) {
          appIds.set(name.toLowerCase(), entry.appId.trim());
        }
      }
    }

    console.error(
      `[connector-registry] Loaded ${names.length} connector names from ${filePath}` +
      (appIds.size ? ` (${appIds.size} with pinned appId)` : "")
    );
    return { names, appIds };
  } catch (err) {
    console.error(`[connector-registry] Failed to parse connectors.json: ${String(err)}`);
    return { names: [], appIds: new Map() };
  }
}

let _registry: Registry | null = null;

function getRegistry(): Registry {
  if (_registry === null) _registry = loadRegistry();
  return _registry;
}

/** Force reload from disk (e.g. after the file is edited at runtime). */
export function reloadRegistry(): void {
  _registry = null;
}

/** Return all registered connector names. */
export function listConnectorNames(): string[] {
  return [...getRegistry().names];
}

/**
 * Return the pinned platform app ID for a connector name, if one was specified
 * in connectors.json as `{ "name": "Box", "appId": "wm.box" }`.
 * Returns undefined when no appId is pinned.
 */
export function getPinnedAppId(nameHint: string): string | undefined {
  const { appIds } = getRegistry();
  // Try exact lowercase match first, then normalised
  return appIds.get(nameHint.toLowerCase()) ?? appIds.get(norm(nameHint).toLowerCase());
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

/** Lower-case, collapse whitespace, strip non-alphanumeric except spaces. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Public matcher ───────────────────────────────────────────────────────────

/**
 * Check the hint against every name in connectors.json.
 *
 * Returns the exact registered name (e.g. "Microsoft Teams") when a
 * sufficiently close match is found, otherwise null.
 *
 * Matching rules (in priority order):
 *  1. Exact case-insensitive match               — "trello"        → "Trello"
 *  2. Registered name is a prefix of the hint    — "trello boards" → "Trello"
 *  3. Hint is a prefix of the registered name    — "microsoft"     → first Microsoft connector
 *  4. All hint words appear in the registered name
 */
export function matchConnectorName(hint: string): string | null {
  const names = getRegistry().names;
  if (!names.length) return null;

  const h = norm(hint);

  // Pass 1: exact match
  for (const name of names) {
    if (norm(name) === h) return name;
  }

  // Pass 2: registered name contained in hint  ("trello boards" → "trello")
  for (const name of names) {
    if (h.includes(norm(name))) return name;
  }

  // Pass 3: hint contained in registered name  ("microsoft" → "Microsoft Teams")
  for (const name of names) {
    if (norm(name).startsWith(h)) return name;
  }

  // Pass 4: all hint words are present in the registered name
  const hWords = h.split(" ").filter(Boolean);
  for (const name of names) {
    const nWords = new Set(norm(name).split(" "));
    if (hWords.length > 0 && hWords.every((w) => nWords.has(w))) return name;
  }

  return null;
}
