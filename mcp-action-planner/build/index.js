#!/usr/bin/env node
/**
 * index.ts  —  MCP Action Planner Server
 *
 * Exposes three MCP tools:
 *
 *  analyze_request
 *    Given a natural-language request, returns the full execution plan
 *    including application discovery, primary-action identification, input
 *    classification, supporting-action resolution, and topological execution order.
 *
 *  invalidate_cache
 *    Forces re-fetch of all cached metadata for a given application ID.
 *    Useful when connector metadata has been updated.
 *
 *  list_connectors
 *    Lists all connectors registered in connectors.json that the planner
 *    knows about, along with their platform IDs and aliases.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeRequest } from "./requestAnalyzer.js";
import { invalidateApplicationCache } from "./metadataClient.js";
import { listConnectorNames, reloadRegistry } from "./connectorRegistry.js";
// ─── Server setup ─────────────────────────────────────────────────────────────
const server = new McpServer({
    name: "mcp-action-planner",
    version: "0.1.0",
});
// ─── Tool: analyze_request ────────────────────────────────────────────────────
server.registerTool("analyze_request", {
    description: [
        "Analyzes a natural-language request to determine which application actions",
        "are required to fulfill it, what inputs those actions need, how those inputs",
        "can be resolved from other available actions, and in what order the actions",
        "must be executed.",
        "",
        "Returns:",
        "  - status: 'resolvable' | 'ambiguous' | 'unresolvable' | 'error'",
        "  - application: identified application name and ID",
        "  - primaryAction: the main action that fulfills the request",
        "  - classifiedInputs: each required input with its resolution status",
        "  - executionPlan: ordered list of steps with inputs/outputs mapped",
        "  - humanReadable: a plain-text summary of the plan",
        "  - issues: list of unresolved or ambiguous inputs",
    ].join("\n"),
    inputSchema: z.object({
        request: z
            .string()
            .min(5)
            .describe("The natural-language request to analyze. " +
            "Must reference the application name, e.g. " +
            "'Add Green label to card ABC in Trello' or " +
            "'Post a message to #general in Slack'"),
    }),
}, async ({ request }) => {
    try {
        const result = await analyzeRequest(request);
        // Return both the structured JSON and the human-readable plan as text
        const jsonOutput = JSON.stringify(result, null, 2);
        const combined = `${result.humanReadable}\n\n---\n\n${jsonOutput}`;
        return {
            content: [
                {
                    type: "text",
                    text: combined,
                },
            ],
            isError: result.status === "error",
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [
                {
                    type: "text",
                    text: `Analysis failed: ${message}`,
                },
            ],
            isError: true,
        };
    }
});
// ─── Tool: invalidate_cache ───────────────────────────────────────────────────
server.registerTool("invalidate_cache", {
    description: "Invalidates all locally cached metadata (actions, triggers, schemas) for a specific " +
        "application ID. Call this after updating a connector's metadata so the planner " +
        "picks up the latest schemas on the next request.",
    inputSchema: z.object({
        appId: z
            .string()
            .min(1)
            .describe("The application ID whose metadata cache should be cleared."),
    }),
}, async ({ appId }) => {
    invalidateApplicationCache(appId);
    return {
        content: [
            {
                type: "text",
                text: `Cache invalidated for application "${appId}". Next request will re-fetch all metadata.`,
            },
        ],
    };
});
// ─── Tool: list_connectors ────────────────────────────────────────────────────
server.registerTool("list_connectors", {
    description: "Lists all connectors registered in connectors.json. " +
        "Shows each connector's name, platform ID (if known), aliases, and description. " +
        "Use this to verify which connectors the planner can recognise, or to find the " +
        "exact name to use in an analyze_request call.",
    inputSchema: z.object({
        reload: z
            .boolean()
            .optional()
            .describe("Set to true to reload connectors.json from disk before listing (default: false)."),
    }),
}, async ({ reload }) => {
    if (reload)
        reloadRegistry();
    const connectors = listConnectorNames();
    if (!connectors.length) {
        return {
            content: [
                {
                    type: "text",
                    text: "No connectors are currently registered. Edit connectors.json to add connectors.",
                },
            ],
        };
    }
    const lines = [
        `Registered connectors (${connectors.length}):`,
        "",
        ...connectors.map((name) => `• ${name}`),
    ];
    return {
        content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: JSON.stringify(connectors, null, 2) },
        ],
    };
});
// ─── Start server ─────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[mcp-action-planner] Server running on stdio");
}
main().catch((err) => {
    console.error("[mcp-action-planner] Fatal error:", err);
    process.exit(1);
});
