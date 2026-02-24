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

export async function fetchJSON(url: string) {
  const res = await fetch(url, { headers });
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
        "Find nearby stores with discounted food waste items. Accepts a Danish ZIP code (e.g. '8000'), GPS coordinates (e.g. '56.15,10.21'), or a Danish address (e.g. 'Vestergade 1, Aarhus'). Returns stores with their clearance products, prices, and discounts.",
      inputSchema: z.object({
        location: z
          .string()
          .describe("Danish ZIP code, GPS coordinates (lat,lon), or a Danish street address"),
        radius: z
          .number()
          .optional()
          .describe("Search radius in km (default: 5). Only used for coordinate/address lookups."),
      }),
    },
    handler: async ({ location, radius }: { location: string; radius?: number }) => {
      const resolved = await resolveLocation(location);
      let url: string;
      if (resolved.type === "zip") {
        url = `${API_BASE}/v1/food-waste/?zip=${encodeURIComponent(resolved.zip)}`;
      } else {
        url = `${API_BASE}/v1/food-waste/?geo=${resolved.lat},${resolved.lon}`;
        if (radius !== undefined) url += `&radius=${radius}`;
      }
      const data = await fetchJSON(url);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  },
  get_store_food_waste: {
    config: {
      title: "Get store food waste",
      description:
        "Get the full list of discounted food waste products for a specific store by its Salling store ID.",
      inputSchema: z.object({
        storeId: z.string().describe("Salling store ID"),
      }),
    },
    handler: async ({ storeId }: { storeId: string }) => {
      const data = await fetchJSON(
        `${API_BASE}/v1/food-waste/${encodeURIComponent(storeId)}`
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  },
};
