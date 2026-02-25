---
name: madspild
description: Find discounted food waste (madspild) from Danish supermarkets (Netto, Føtex, Bilka). Triggers on food waste, cheap groceries, meal planning, "madspild", "tilbud", nearby deals.
allowed-tools:
  - mcp__claude_ai_Madspild__search_food_waste
  - mcp__claude_ai_Madspild__get_store_food_waste
---

# Madspild — Salling Food Waste

Query the Salling Group API for discounted food-waste items at nearby stores via MCP tools.

## MCP Tools

### search_food_waste

Find nearby stores with clearance items. Accepts:
- Danish ZIP code (e.g. `8000`)
- GPS coordinates (e.g. `56.15,10.21`)
- Danish address (e.g. `Vestergade 1, Aarhus`)
- Optional `radius` in km (default: 1)

### get_store_food_waste

Get all discounted products for a specific store by Salling store ID.

## Output Format

Each product includes:
- Product name, original price, offer price, discount percentage
- Use-by date (offer.endTime) and remaining stock (offer.stock)

## Suggested Workflow

1. Search by location to find nearby stores with deals
2. Pick interesting stores from the results
3. Use `get_store_food_waste` for full product lists on specific stores
4. Summarize the best deals, group by category, or suggest meals from available items
