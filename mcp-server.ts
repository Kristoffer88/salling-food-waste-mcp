import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash } from "node:crypto";
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

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, { host: "https://eu.i.posthog.com" })
  : null;

let httpServer: ReturnType<typeof createServer> | null = null;

async function shutdown() {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
  await posthog?.shutdown();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

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

async function fetchJSON(url: string, apiKeyOverride?: string) {
  const useServerQuota = !apiKeyOverride;
  const authHeaders = { Authorization: `Bearer ${apiKeyOverride ?? API_KEY}` };

  if (useServerQuota) {
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
  }

  const res = await fetch(url, { headers: authHeaders });

  if (useServerQuota) {
    const retryMs = parseRetryAfter(res.headers.get("retry-after"));
    if (retryMs) nextAllowedAt = Date.now() + retryMs;
  }

  if (res.status === 429) {
    if (!useServerQuota) {
      throw new RateLimitError(`Salling API rate limit hit (429). Your API key is being throttled.`);
    }
    const retryMs = parseRetryAfter(res.headers.get("retry-after"));
    const retryWait = retryMs ?? 60_000;
    if (retryWait <= MAX_WAIT_MS) {
      await sleep(retryWait);
      dailyCount++;
      const retryRes = await fetch(url, { headers: authHeaders });
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

// --- Response cache ---

const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? "300000", 10); // 5 min default
const GEOCODE_CACHE_TTL_MS = 3_600_000; // 1 hour
const MAX_CACHE_SIZE = 10_000;

const cache = new Map<string, { data: unknown; expiry: number }>();

function cacheGet(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) { cache.delete(key); return undefined; }
  return entry.data;
}

function cacheSet(key: string, data: unknown, ttl = CACHE_TTL_MS): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value!;
    cache.delete(firstKey);
  }
  cache.set(key, { data, expiry: Date.now() + ttl });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiry) cache.delete(key);
  }
}, 60_000).unref();

// --- Geocoding ---

const ZIP_RE = /^\d{4}$/;
const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

async function geocode(address: string): Promise<{ lat: number; lon: number }> {
  const cleaned = address.replace(/\b\d{4}\s+/g, "").replace(/\s+[A-Z](?:\s*,|$)/g, ",").replace(/,\s*$/, "").trim();
  const cacheKey = `geocode:${cleaned.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached as { lat: number; lon: number };

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleaned + ", Denmark")}&format=json&limit=1&countrycodes=dk`;
  const res = await fetch(url, { headers: { "User-Agent": "salling-food-waste-mcp/1.0" } });
  if (!res.ok) throw new Error(`Nominatim geocoding error: ${res.status}`);
  const results = await res.json() as { lat: string; lon: string }[];
  if (!results.length) throw new Error(`Could not geocode address: "${address}"`);
  const result = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  cacheSet(cacheKey, result, GEOCODE_CACHE_TTL_MS);
  return result;
}

async function resolveLocation(location: string) {
  const trimmed = location.trim();
  if (ZIP_RE.test(trimmed)) return { type: "zip" as const, zip: trimmed };
  const coordMatch = trimmed.match(COORD_RE);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error(`Invalid coordinates: lat must be [-90,90] and lon must be [-180,180], got ${lat},${lon}`);
    }
    return { type: "geo" as const, lat, lon };
  }
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
    product: { description: string; categories?: { da?: string; en?: string } };
  }[];
}

// --- API response validation ---

function validateStoreResult(data: unknown): SallingStoreResult {
  if (typeof data !== "object" || data === null || !("store" in data) || !("clearances" in data)) {
    throw new Error("Unexpected API response: missing store or clearances");
  }
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.clearances)) {
    throw new Error("Unexpected API response: clearances is not an array");
  }
  return data as SallingStoreResult;
}

function validateStoreResults(data: unknown): SallingStoreResult[] {
  if (!Array.isArray(data)) {
    throw new Error("Unexpected API response: expected an array of store results");
  }
  return data.map(validateStoreResult);
}

// --- MCP server ---

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createMcpServer(apiKeyOverride?: string): McpServer {
  const server = new McpServer({
    name: "salling-food-waste",
    version: "1.0.0",
    description:
      "Access discounted food waste products from Salling Group stores (Netto, føtex, Bilka) across Denmark. Helps users find nearby stores with clearance items, see prices, discounts, stock levels, and expiry dates. Useful for saving money on groceries and reducing food waste.\n\nTypical workflow: 1) Search for nearby stores by location → 2) Get product list for a specific store → 3) Present grouped and sorted results to the user.",
  });

  server.registerTool(
    "search_food_waste",
    {
      title: "Search food waste",
      description:
        "Find nearby Salling Group stores (Netto, føtex, Bilka) with discounted food waste items.\n\nAccepts a Danish ZIP code (e.g. '8000'), GPS coordinates (e.g. '56.15,10.21'), or a Danish street address including city (e.g. 'Vestergade 1, Aarhus'). Addresses must include city name to geocode reliably — if geocoding fails, retry with the ZIP code instead.\n\nReturns a list of stores with store ID, name, brand, address, and number of available items. Use the store ID with get_store_food_waste to fetch the full product list.\n\nOnly covers Salling Group stores — not Rema 1000, Lidl, Aldi, etc.",
      inputSchema: z.object({
        location: z.string().min(1).max(500).describe("Danish ZIP code, GPS coordinates (lat,lon), or a Danish street address"),
        radius: z.number().min(0.1).max(200).optional().describe("Search radius in km (default: 1). Only used for coordinate/address lookups."),
      }),
    },
    async ({ location, radius }: { location: string; radius?: number }) => {
      const resolved = await resolveLocation(location);
      const cacheKey = resolved.type === "zip"
        ? `zip:${resolved.zip}`
        : `geo:${resolved.lat.toFixed(2)},${resolved.lon.toFixed(2)}:${Math.round(radius ?? 1)}`;
      const cached = cacheGet(cacheKey);
      if (cached) return textResult(cached);

      const url = resolved.type === "zip"
        ? `${API_BASE}/v1/food-waste/?zip=${encodeURIComponent(resolved.zip)}`
        : `${API_BASE}/v1/food-waste/?geo=${resolved.lat},${resolved.lon}&radius=${radius ?? 1}`;
      const data = validateStoreResults(await fetchJSON(url, apiKeyOverride));
      const result = data.map((s) => ({
        storeId: s.store.id,
        name: s.store.name,
        brand: s.store.brand,
        address: s.store.address,
        itemCount: s.clearances.length,
      }));
      cacheSet(cacheKey, result);
      return textResult(result);
    },
  );

  server.registerTool(
    "get_store_food_waste",
    {
      title: "Get store food waste",
      description:
        "Get all discounted food waste products for a specific Salling Group store.\n\nReturns product name, original price, discounted price, discount percentage, remaining stock, and expiry date per item. The category field may be null for some products.\n\nWhen presenting results to the user:\n- Group products by type (dairy, meat, bread, etc.) based on the product name — Danish product names typically contain the product type and brand (e.g. 'DANBO 45+ MAMMEN' = cheese, 'SKAFTEKOTELET PREMIEUR' = pork).\n- Highlight the best deals (40%+ discount) and items expiring today/tomorrow.\n- Include stock count so the user knows availability.\n- Note that prices are in DKK and stock can change quickly — items may be sold out in-store.",
      inputSchema: z.object({
        storeId: z.string().min(1).max(100).describe("Salling store ID"),
      }),
    },
    async ({ storeId }: { storeId: string }) => {
      const cacheKey = `store:${storeId}`;
      const cached = cacheGet(cacheKey);
      if (cached) return textResult(cached);

      const data = validateStoreResult(await fetchJSON(`${API_BASE}/v1/food-waste/${encodeURIComponent(storeId)}`, apiKeyOverride));
      const result = data.clearances.map((c) => ({
        product: c.product.description,
        category: c.product.categories?.da || c.product.categories?.en || null,
        newPrice: c.offer.newPrice,
        originalPrice: c.offer.originalPrice,
        discount: `${c.offer.percentDiscount}%`,
        stock: c.offer.stock,
        expires: c.offer.endTime,
      }));
      cacheSet(cacheKey, result);
      return textResult(result);
    },
  );

  return server;
}

// --- Per-IP rate limiting ---

const IP_WINDOW_MS = parseInt(process.env.IP_RATE_WINDOW_MS ?? "60000", 10);
const IP_MAX_REQUESTS = parseInt(process.env.IP_RATE_LIMIT ?? "10", 10);
const MAX_IP_MAP_SIZE = 10_000;
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
  if (timestamps.length === 0) { ipRequests.delete(ip); return false; }
  if (timestamps.length >= IP_MAX_REQUESTS) return true;
  if (ipRequests.size >= MAX_IP_MAP_SIZE) {
    const firstKey = ipRequests.keys().next().value!;
    ipRequests.delete(firstKey);
  }
  timestamps.push(now);
  return false;
}

// --- HTTP + Stdio transports ---

function jsonRpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

async function runHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  httpServer = createServer(async (req, res) => {
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

    const anonId = createHash("sha256").update(ip).digest("hex").slice(0, 16);

    if (isIpRateLimited(ip)) {
      posthog?.capture({ distinctId: anonId, event: "ip_rate_limited" });
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(jsonRpcError(-32005, `Rate limit exceeded. Max ${IP_MAX_REQUESTS} requests per minute.`));
      return;
    }

    posthog?.capture({ distinctId: anonId, event: "mcp_request" });

    try {
      const userApiKey = typeof req.headers["x-salling-api-key"] === "string"
        ? req.headers["x-salling-api-key"]
        : undefined;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer(userApiKey);
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
    fetch("https://icanhazip.com/").then((r) => r.text()).then((ip) => {
      console.error(`Egress IP: ${ip.trim()}`);
    }).catch(() => {});
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
