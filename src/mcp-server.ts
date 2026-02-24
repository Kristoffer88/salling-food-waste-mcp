import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage } from "node:http";
import { PostHog } from "posthog-node";
import { tools } from "./core.js";

// --- PostHog analytics ---

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, { host: "https://eu.i.posthog.com" })
  : null;

// --- Per-IP rate limiter (sliding window) ---

const IP_WINDOW_MS = 60_000; // 1 minute
const IP_MAX_REQUESTS = parseInt(process.env.IP_RATE_LIMIT ?? "10", 10);
const ipRequests = new Map<string, number[]>();

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Returns true if the request should be rejected (rate limited). */
function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  let timestamps = ipRequests.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipRequests.set(ip, timestamps);
  }
  // Prune entries outside the window
  const cutoff = now - IP_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= IP_MAX_REQUESTS) return true;
  timestamps.push(now);
  return false;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "salling-food-waste",
    version: "1.0.0",
  });
  for (const [name, { config, handler }] of Object.entries(tools)) {
    server.registerTool(name, config, handler);
  }
  return server;
}

// --- HTTP mode: Streamable HTTP on PORT ---

async function runHttp() {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const ip = getClientIp(req);
      if (isIpRateLimited(ip)) {
        posthog?.capture({ distinctId: ip, event: "ip_rate_limited" });
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32005, message: "Rate limit exceeded. Max 10 requests per minute." },
          id: null,
        }));
        return;
      }
      try {
        posthog?.capture({ distinctId: ip, event: "mcp_request" });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("MCP request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
        }
      }
      return;
    }
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(port, () => {
    console.error(`MCP HTTP server listening on http://localhost:${port}/mcp`);
  });
}

// --- Stdio mode: standard MCP JSON-RPC over stdin/stdout ---

async function runStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Entrypoint ---

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await posthog?.shutdown();
  process.exit(0);
});
