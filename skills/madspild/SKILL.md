---
name: madspild
description: Find discounted food waste (madspild) from Danish supermarkets (Netto, Føtex, Bilka). Triggers on food waste, cheap groceries, meal planning, "madspild", "tilbud", nearby deals.
allowed-tools:
  - Bash(npx tsx src/mcp-server.ts:*)
---

# Madspild — Salling Food Waste

Query the Salling Group API for discounted food-waste items at nearby stores.

## CLI Usage

All commands use `--cli <tool> '<args-json>'` and print JSON to stdout.

### Search by location (ZIP, address, or coordinates)

```bash
# By ZIP code
npx tsx src/mcp-server.ts --cli search_food_waste '{"location":"8000"}'

# By Danish address (geocoded via DAWA)
npx tsx src/mcp-server.ts --cli search_food_waste '{"location":"Vestergade 1, Aarhus"}'

# By GPS coordinates
npx tsx src/mcp-server.ts --cli search_food_waste '{"location":"56.15,10.21"}'

# With custom radius (km)
npx tsx src/mcp-server.ts --cli search_food_waste '{"location":"Nørrebrogade 1, København","radius":10}'
```

### Get products for a specific store

```bash
npx tsx src/mcp-server.ts --cli get_store_food_waste '{"storeId":"some-store-id"}'
```

## Output Format

JSON with `content[0].text` containing the API response. Each store entry includes:
- Store name and address
- List of clearance items with original price, offer price, and discount percentage
- Stock and product descriptions

## Suggested Workflow

1. Search by location to find nearby stores with deals
2. Pick interesting stores from the results
3. Use `get_store_food_waste` for full product lists on specific stores
4. Summarize the best deals, group by category, or suggest meals from available items
