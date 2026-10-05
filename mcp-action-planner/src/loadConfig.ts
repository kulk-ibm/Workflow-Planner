/**
 * loadConfig.ts
 *
 * Bootstrap module loaded via `node --import` BEFORE any other module evaluates.
 * Reads <workspace-root>/config.json and injects keys into process.env so that
 * metadataClient.ts (which reads env vars at module-evaluation time) sees them.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// build/loadConfig.js is at:  <workspace>/mcp-action-planner/build/loadConfig.js
// config.json is at:          <workspace>/config.json
// So we go up two levels:     build/ -> mcp-action-planner/ -> workspace/
const CONFIG_FILE = path.resolve(__dirname, "../../config.json");

try {
  const raw = fs.readFileSync(CONFIG_FILE, "utf8");
  const cfg = JSON.parse(raw) as Record<string, string>;
  for (const [key, value] of Object.entries(cfg)) {
    if (!process.env[key]) process.env[key] = value;
  }
  console.error(`[action-planner] Loaded config from ${CONFIG_FILE}`);
} catch {
  // Silent — server.js will fail with a clear error if vars are still missing
}
