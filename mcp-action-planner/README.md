# mcp-action-planner

A **metadata-driven MCP server** that analyzes natural-language requests and dynamically determines which application actions — and which supporting actions — are required to fulfill them.

## How it works

```
Natural Language Request
        ↓
  Application Discovery  (GET /apis/v2/rest/applications/{name})
        ↓
  Action Discovery       (GET /apis/v2/rest/applications/{appId}/actions)
        ↓
  Primary Action Match   (semantic ranking over action names + descriptions)
        ↓
  Schema Fetching        (input + output schemas for all actions in parallel)
        ↓
  Input Classification   (DIRECT / RESOLVABLE_BY_ACTION / AMBIGUOUS / MISSING)
        ↓
  Dependency Resolution  (semantic output→input field matching)
        ↓
  Dependency Graph       (DAG of actions)
        ↓
  Topological Sort       (execution order)
        ↓
  Execution Plan         (JSON + human-readable)
```

No application-specific logic is hardcoded. The same server works for Trello, Slack, HubSpot, Jira, or any other connector exposed via the metadata APIs.

---

## Prerequisites

- Node.js ≥ 18
- An IBM webMethods Integration tenant with the metadata APIs enabled

---

## Installation

```bash
cd mcp-action-planner
npm install
npm run build
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WMIO_BASE_URL` | ✅ | Base URL of your IBM webMethods Integration tenant, e.g. `https://prod821590.a-yqb-c1.int.ipaas.automation.ibm.com` |
| `WMIO_API_KEY` | ✅ | Your instance API key (`X-INSTANCE-API-KEY`) |
| `METADATA_CACHE_TTL_MS` | ❌ | How long to cache metadata in milliseconds (default: `600000` = 10 min) |

---

## MCP tools

### `analyze_request`

Analyzes a natural-language request and returns a complete execution plan.

**Input:**
```json
{
  "request": "Add Green label to card ABC in Trello"
}
```

**Output** (truncated):
```json
{
  "status": "resolvable",
  "application": { "name": "Trello", "appId": "..." },
  "primaryAction": { "name": "Add Label to Card", "actionId": "..." },
  "executionPlan": [
    {
      "step": 1,
      "action": "Search Card",
      "purpose": "Resolve cardId, boardId, listId",
      "inputs": { "name": "ABC" },
      "outputs": {
        "cards[].id":      "Add Label to Card.cardId",
        "cards[].boardId": "Add Label to Card.boardId",
        "cards[].listId":  "Add Label to Card.listId"
      }
    },
    {
      "step": 2,
      "action": "Search Label",
      "purpose": "Resolve labelId",
      "inputs": { "name": "Green" },
      "outputs": { "id": "Add Label to Card.labelId" }
    },
    {
      "step": 3,
      "action": "Add Label to Card",
      "inputs": {
        "boardId": "Search Card.cards[].boardId",
        "listId":  "Search Card.cards[].listId",
        "cardId":  "Search Card.cards[].id",
        "labelId": "Search Label.id"
      }
    }
  ],
  "humanReadable": "Request:\nAdd Green label to card ABC in Trello\n\nPlan:\n..."
}
```

### `invalidate_cache`

Force-invalidates all cached metadata for a given application ID.

**Input:**
```json
{ "appId": "4ae37a28-f740-42b5-b203-bd0e3a196d5b" }
```

---

## Registering with Bob

Add the following to your Bob `mcp.json` (workspace or global):

```json
{
  "mcpServers": {
    "action-planner": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-action-planner/build/index.js"],
      "env": {
        "WMIO_BASE_URL": "${env:WMIO_BASE_URL}",
        "WMIO_API_KEY":  "${env:WMIO_API_KEY}"
      }
    }
  }
}
```

---

## Architecture

| Module | Responsibility |
|---|---|
| `metadataClient.ts` | HTTP calls to all 7 metadata APIs; TTL cache |
| `schemaMatcher.ts` | Semantic field scoring; entity-noun extraction; action intent ranking |
| `dependencyResolver.ts` | Input classification; dependency graph; topological sort |
| `requestAnalyzer.ts` | NL parsing; pipeline orchestration |
| `planFormatter.ts` | Structured JSON + human-readable plan assembly |
| `index.ts` | MCP server; `analyze_request` and `invalidate_cache` tools |

---

## Input classification statuses

| Status | Meaning |
|---|---|
| `DIRECT` | The user provided the value explicitly in the request |
| `DERIVED` | The value can be computed without an extra action call |
| `RESOLVABLE_BY_ACTION` | Another available action can produce this value |
| `AMBIGUOUS` | Multiple candidates exist; disambiguation required |
| `MISSING` | No available action can resolve this value |
