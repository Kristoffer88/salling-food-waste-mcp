---
name: madspild
description: Find discounted food waste (madspild) from Danish supermarkets (Netto, Føtex, Bilka). Triggers on food waste, cheap groceries, meal planning, "madspild", "tilbud", nearby deals.
allowed-tools:
  - Bash(npx tsx src/cli.ts:*)
---

# Madspild — Salling Food Waste

Query the Salling Group API for discounted food-waste items at nearby stores.

## CLI Usage

### Search by location (ZIP, address, or coordinates)

```bash
# By ZIP code
npx tsx src/cli.ts search 8000

# By Danish address (geocoded via Nominatim)
npx tsx src/cli.ts search "Vestergade 1, Aarhus"

# By GPS coordinates
npx tsx src/cli.ts search "56.15,10.21"

# With custom radius (km)
npx tsx src/cli.ts search "Nørrebrogade 1, København" --radius 10

# Raw JSON output
npx tsx src/cli.ts search 8000 --json
```

### Get products for a specific store

```bash
npx tsx src/cli.ts store <store-id>
npx tsx src/cli.ts store <store-id> --json
```

## Output Format

Human-readable by default. Each product line shows:
- Product name, original price, offer price, discount percentage
- Use-by date (offer.endTime) and remaining stock (offer.stock)

Use `--json` for raw API JSON.

## Suggested Workflow

1. Search by location to find nearby stores with deals
2. Pick interesting stores from the results
3. Use `store <id>` for full product lists on specific stores
4. Summarize the best deals, group by category, or suggest meals from available items
