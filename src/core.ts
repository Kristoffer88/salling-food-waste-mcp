import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const API_BASE = "https://api.sallinggroup.com";
export const API_KEY = process.env.SALLING_API_KEY;

if (!API_KEY) {
  console.error("Missing SALLING_API_KEY in environment");
  process.exit(1);
}

export const headers = { Authorization: `Bearer ${API_KEY}` };

// --- Salling API rate-limit state ---

let nextAllowedAt = 0;   // epoch ms — set from Retry-After
let dailyCount = 0;
let dailyResetDate = "";  // "YYYY-MM-DD" UTC

const DAILY_QUOTA_LIMIT = 9_500; // soft cap (hard limit is 10,000)

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

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export async function fetchJSON(url: string) {
  // Reset daily counter on new UTC day
  const today = todayUTC();
  if (dailyResetDate !== today) {
    dailyCount = 0;
    dailyResetDate = today;
  }

  // Pre-request check: respect Retry-After from a previous response
  if (Date.now() < nextAllowedAt) {
    const waitSec = Math.ceil((nextAllowedAt - Date.now()) / 1000);
    throw new RateLimitError(
      `Salling API rate-limited. Try again in ${waitSec}s.`
    );
  }

  // Pre-request check: daily quota soft cap
  if (dailyCount >= DAILY_QUOTA_LIMIT) {
    throw new RateLimitError(
      `Daily API quota nearly exhausted (${dailyCount}/${DAILY_QUOTA_LIMIT}). Requests paused until midnight UTC.`
    );
  }

  dailyCount++;

  const res = await fetch(url, { headers });

  // Always check Retry-After (some APIs send it on 200 as a warning)
  const retryMs = parseRetryAfter(res.headers.get("retry-after"));
  if (retryMs) {
    nextAllowedAt = Date.now() + retryMs;
  }

  if (res.status === 429) {
    const waitSec = retryMs ? Math.ceil(retryMs / 1000) : 60;
    throw new RateLimitError(
      `Salling API rate limit hit (429). Retry after ${waitSec}s.`
    );
  }

  if (!res.ok) {
    throw new Error(`Salling API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Geocoding via Nominatim (OpenStreetMap) ---

export async function geocode(address: string): Promise<{ lat: number; lon: number }> {
  // Strip Danish postal codes and district suffixes (e.g. "8000 Aarhus C" → "Aarhus")
  const cleaned = address.replace(/\b\d{4}\s+/g, "").replace(/\s+[A-Z](?:\s*,|$)/g, ",").replace(/,\s*$/, "").trim();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleaned + ", Denmark")}&format=json&limit=1&countrycodes=dk`;
  const res = await fetch(url, {
    headers: { "User-Agent": "mad-mcp-server/1.0" },
  });
  if (!res.ok) throw new Error(`Nominatim geocoding error: ${res.status}`);
  const results = await res.json() as { lat: string; lon: string }[];
  if (!results.length) throw new Error(`Could not geocode address: "${address}"`);
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

// --- Location parsing ---

export const ZIP_RE = /^\d{4}$/;
export const COORD_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

export async function resolveLocation(location: string): Promise<
  | { type: "zip"; zip: string }
  | { type: "geo"; lat: number; lon: number }
> {
  const trimmed = location.trim();
  if (ZIP_RE.test(trimmed)) return { type: "zip", zip: trimmed };
  const coordMatch = trimmed.match(COORD_RE);
  if (coordMatch) return { type: "geo", lat: parseFloat(coordMatch[1]), lon: parseFloat(coordMatch[2]) };
  const { lat, lon } = await geocode(trimmed);
  return { type: "geo", lat, lon };
}

// --- Salling API response types ---

interface SallingAddress {
  city: string;
  country: string;
  extra: string | null;
  street: string;
  zip: string;
}

interface SallingStore {
  id: string;
  name: string;
  brand: string;
  address: SallingAddress;
}

interface SallingOffer {
  newPrice: number;
  originalPrice: number;
  percentDiscount: number;
  stock: number;
  endTime: string;
}

interface SallingProduct {
  description: string;
  categories: { da?: string; en?: string };
}

interface SallingClearance {
  offer: SallingOffer;
  product: SallingProduct;
}

interface SallingStoreResult {
  store: SallingStore;
  clearances: SallingClearance[];
}

// --- Tool definitions (shared across all modes) ---

export type ToolDef = {
  config: {
    title?: string;
    description?: string;
    inputSchema?: any;
  };
  handler: (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;
};

export const tools: Record<string, ToolDef> = {
  search_food_waste: {
    config: {
      title: "Search food waste",
      description:
        "Find nearby stores with discounted food waste items. Accepts a Danish ZIP code (e.g. '8000'), GPS coordinates (e.g. '56.15,10.21'), or a Danish address (e.g. 'Vestergade 1, Aarhus'). Returns stores with their clearance products, prices, discounts, use-by date (offer.endTime), and remaining stock (offer.stock).",
      inputSchema: z.object({
        location: z
          .string()
          .describe("Danish ZIP code, GPS coordinates (lat,lon), or a Danish street address"),
        radius: z
          .number()
          .optional()
          .describe("Search radius in km (default: 1). Only used for coordinate/address lookups."),
      }),
    },
    handler: async ({ location, radius }: { location: string; radius?: number }) => {
      const resolved = await resolveLocation(location);
      let url: string;
      if (resolved.type === "zip") {
        url = `${API_BASE}/v1/food-waste/?zip=${encodeURIComponent(resolved.zip)}`;
      } else {
        url = `${API_BASE}/v1/food-waste/?geo=${resolved.lat},${resolved.lon}&radius=${radius ?? 1}`;
      }
      const data = await fetchJSON(url) as SallingStoreResult[];
      const summary = data.map((s) => ({
        storeId: s.store.id,
        name: s.store.name,
        brand: s.store.brand,
        address: s.store.address,
        itemCount: s.clearances.length,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  },
  get_store_food_waste: {
    config: {
      title: "Get store food waste",
      description:
        "Get the full list of discounted food waste products for a specific store by its Salling store ID. Includes use-by date (offer.endTime) and remaining stock (offer.stock) per item.",
      inputSchema: z.object({
        storeId: z.string().describe("Salling store ID"),
      }),
    },
    handler: async ({ storeId }: { storeId: string }) => {
      const data = await fetchJSON(
        `${API_BASE}/v1/food-waste/${encodeURIComponent(storeId)}`
      ) as SallingClearance[];
      const items = data.map((c) => ({
        product: c.product.description,
        category: c.product.categories.da || c.product.categories.en,
        newPrice: c.offer.newPrice,
        originalPrice: c.offer.originalPrice,
        discount: `${c.offer.percentDiscount}%`,
        stock: c.offer.stock,
        expires: c.offer.endTime,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
    },
  },
};
