#!/usr/bin/env node
/**
 * server.ts — HTTP server for the Action Planner UI
 *
 * Exposes:
 *   POST /analyze   { request: string } → AnalysisResult JSON
 *   GET  /           → serves the HTML UI
 *
 * env vars (WMIO_BASE_URL, WMIO_API_KEY) are loaded from <workspace-root>/config.json
 * by the --import bootstrap: `node --import ./build/loadConfig.js build/server.js`
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeRequest } from "./requestAnalyzer.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "4000", 10);
const UI_FILE = path.resolve(__dirname, "../../ui/index.html");
const server = http.createServer(async (req, res) => {
    // ── CORS for local dev ────────────────────────────────────────────────────
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }
    // ── POST /analyze ──────────────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/analyze") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
            try {
                const { request } = JSON.parse(body);
                if (!request || request.trim().length < 5) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "request must be at least 5 characters" }));
                    return;
                }
                const result = await analyzeRequest(request.trim());
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result, null, 2));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: msg }));
            }
        });
        return;
    }
    // ── GET / → serve UI ──────────────────────────────────────────────────────
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        try {
            const html = fs.readFileSync(UI_FILE, "utf8");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        }
        catch {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("UI not found. Expected at: " + UI_FILE);
        }
        return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
});
server.listen(PORT, () => {
    console.log(`[action-planner-ui] HTTP server running at http://localhost:${PORT}`);
});
