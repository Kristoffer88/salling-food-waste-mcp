import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage } from "node:http";
import { PostHog } from "posthog-node";
import { z } from "zod";

// --- Config ---

const API_BASE = "https://api.sallinggroup.com";
const API_KEY = process.env.SALLING_API_KEY;

if (!API_KEY) {
  console.error("Missing SALLING_API_KEY in environment");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}` };

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, { host: "https://eu.i.posthog.com" })
  : null;

process.on("SIGTERM", async () => {
  await posthog?.shutdown();
  process.exit(0);
});

// --- Salling API rate limiting ---

let nextAllowedAt = 0;
let dailyCount = 0;
let dailyResetDate = "";

const DAILY_QUOTA_LIMIT = 9_500;
const MAX_WAIT_MS = parseInt(process.env.MAX_RETRY_WAIT_MS ?? "5000", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

async function fetchJSON(url: string) {
  const today = todayUTC();
  if (dailyResetDate !== today) {
    dailyCount = 0;
    dailyResetDate = today;
  }

  const waitMs = nextAllowedAt - Date.now();
  if (waitMs > 0 && waitMs <= MAX_WAIT_MS) {
    await sleep(waitMs);
  } else if (waitMs > 0) {
    const waitSec = Math.ceil(waitMs / 1000);
    throw new RateLimitError(`Salling API rate-limited. Try again in ${waitSec}s.`);
  }

  if (dailyCount >= DAILY_QUOTA_LIMIT) {
    throw new RateLimitError(
      `Daily API quota nearly exhausted (${dailyCount}/${DAILY_QUOTA_LIMIT}). Requests paused until midnight UTC.`
    );
  }

  dailyCount++;
  const res = await fetch(url, { headers });

  const retryMs = parseRetryAfter(res.headers.get("retry-after"));
  if (retryMs) nextAllowedAt = Date.now() + retryMs;

  if (res.status === 429) {
    const retryWait = retryMs ?? 60_000;
    if (retryWait <= MAX_WAIT_MS) {
      await sleep(retryWait);
      dailyCount++;
      const retryRes = await fetch(url, { headers });
      const retryRetryMs = parseRetryAfter(retryRes.headers.get("retry-after"));
      if (retryRetryMs) nextAllowedAt = Date.now() + retryRetryMs;
      if (!retryRes.ok) {
        throw new RateLimitError(`Salling API rate limit hit (${retryRes.status}) after retry.`);
      }
      return retryRes.json();
    }
    const waitSec = Math.ceil(retryWait / 1000);
    throw new RateLimitError(`Salling API rate limit hit (429). Retry after ${waitSec}s.`);
  }

  if (!res.ok) throw new Error(`Salling API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// --- Geocoding ---

const ZIP_RE = /^\d{4}$/;
const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

async function geocode(address: string): Promise<{ lat: number; lon: number }> {
  const cleaned = address.replace(/\b\d{4}\s+/g, "").replace(/\s+[A-Z](?:\s*,|$)/g, ",").replace(/,\s*$/, "").trim();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleaned + ", Denmark")}&format=json&limit=1&countrycodes=dk`;
  const res = await fetch(url, { headers: { "User-Agent": "salling-food-waste-mcp/1.0" } });
  if (!res.ok) throw new Error(`Nominatim geocoding error: ${res.status}`);
  const results = await res.json() as { lat: string; lon: string }[];
  if (!results.length) throw new Error(`Could not geocode address: "${address}"`);
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

async function resolveLocation(location: string) {
  const trimmed = location.trim();
  if (ZIP_RE.test(trimmed)) return { type: "zip" as const, zip: trimmed };
  const coordMatch = trimmed.match(COORD_RE);
  if (coordMatch) return { type: "geo" as const, lat: parseFloat(coordMatch[1]), lon: parseFloat(coordMatch[2]) };
  const { lat, lon } = await geocode(trimmed);
  return { type: "geo" as const, lat, lon };
}

// --- Salling API types ---

interface SallingStoreResult {
  store: {
    id: string;
    name: string;
    brand: string;
    address: { city: string; country: string; extra: string | null; street: string; zip: string };
  };
  clearances: {
    offer: { newPrice: number; originalPrice: number; percentDiscount: number; stock: number; endTime: string };
    product: { description: string; categories: { da?: string; en?: string } };
  }[];
}

// --- MCP server ---

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "salling-food-waste", version: "1.0.0" });

  server.registerTool(
    "search_food_waste",
    {
      title: "Search food waste",
      description:
        "Find nearby stores with discounted food waste items. Accepts a Danish ZIP code (e.g. '8000'), GPS coordinates (e.g. '56.15,10.21'), or a Danish address (e.g. 'Vestergade 1, Aarhus'). Returns stores with their clearance products, prices, discounts, use-by date (offer.endTime), and remaining stock (offer.stock).",
      inputSchema: z.object({
        location: z.string().describe("Danish ZIP code, GPS coordinates (lat,lon), or a Danish street address"),
        radius: z.number().optional().describe("Search radius in km (default: 1). Only used for coordinate/address lookups."),
      }),
    },
    async ({ location, radius }: { location: string; radius?: number }) => {
      const resolved = await resolveLocation(location);
      const url = resolved.type === "zip"
        ? `${API_BASE}/v1/food-waste/?zip=${encodeURIComponent(resolved.zip)}`
        : `${API_BASE}/v1/food-waste/?geo=${resolved.lat},${resolved.lon}&radius=${radius ?? 1}`;
      const data = (await fetchJSON(url)) as SallingStoreResult[];
      return textResult(data.map((s) => ({
        storeId: s.store.id,
        name: s.store.name,
        brand: s.store.brand,
        address: s.store.address,
        itemCount: s.clearances.length,
      })));
    },
  );

  server.registerTool(
    "get_store_food_waste",
    {
      title: "Get store food waste",
      description:
        "Get the full list of discounted food waste products for a specific store by its Salling store ID. Includes use-by date (offer.endTime) and remaining stock (offer.stock) per item.",
      inputSchema: z.object({
        storeId: z.string().describe("Salling store ID"),
      }),
    },
    async ({ storeId }: { storeId: string }) => {
      const data = (await fetchJSON(`${API_BASE}/v1/food-waste/${encodeURIComponent(storeId)}`)) as SallingStoreResult;
      return textResult(data.clearances.map((c) => ({
        product: c.product.description,
        category: c.product.categories.da || c.product.categories.en,
        newPrice: c.offer.newPrice,
        originalPrice: c.offer.originalPrice,
        discount: `${c.offer.percentDiscount}%`,
        stock: c.offer.stock,
        expires: c.offer.endTime,
      })));
    },
  );

  return server;
}

// --- Per-IP rate limiting ---

const IP_WINDOW_MS = parseInt(process.env.IP_RATE_WINDOW_MS ?? "60000", 10);
const IP_MAX_REQUESTS = parseInt(process.env.IP_RATE_LIMIT ?? "10", 10);
const ipRequests = new Map<string, number[]>();

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - IP_WINDOW_MS;
  let timestamps = ipRequests.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipRequests.set(ip, timestamps);
  }
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;
  if (timestamps.length >= IP_MAX_REQUESTS) return true;
  timestamps.push(now);
  return false;
}

// --- HTTP + Stdio transports ---

function jsonRpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

async function runHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ip = getClientIp(req);

    if (isIpRateLimited(ip)) {
      posthog?.capture({ distinctId: ip, event: "ip_rate_limited" });
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(jsonRpcError(-32005, `Rate limit exceeded. Max ${IP_MAX_REQUESTS} requests per minute.`));
      return;
    }

    posthog?.capture({ distinctId: ip, event: "mcp_request" });

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(jsonRpcError(-32603, "Internal server error"));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`MCP HTTP server listening on http://localhost:${port}/mcp`);
  });
}

async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv.includes("--http")) {
  runHttp().catch((err) => { console.error(err); process.exit(1); });
} else {
  runStdio().catch((err) => { console.error(err); process.exit(1); });
}
