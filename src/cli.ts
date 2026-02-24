#!/usr/bin/env node
import { tools } from "./core.js";

function printUsage() {
  console.error(`Usage:
  mad search <location> [--radius <km>] [--json]
  mad store <storeId> [--json]

Examples:
  mad search 8000
  mad search "Silkeborgvej 86, 8000 Aarhus C" --radius 1
  mad search "56.15,10.21" --json
  mad store 2e17c725-e4db-43f8-a1a3-059e23c3151c`);
  process.exit(1);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatItem(item: any): string {
  const pct = Math.round((1 - item.offer.newPrice / item.offer.originalPrice) * 100);
  const useBy = item.offer.endTime ? ` — use by ${formatDate(item.offer.endTime)}` : "";
  const stock = item.offer.stock != null ? `, ${item.offer.stock} left` : "";
  return `    ${item.product.description}: ${item.offer.originalPrice} kr → ${item.offer.newPrice} kr (${pct}% off${useBy}${stock})`;
}

function formatSearch(data: any[]) {
  if (!data.length) {
    console.log("No stores found.");
    return;
  }
  for (const entry of data) {
    const s = entry.store;
    console.log(`\n${s.name} (${s.brand})`);
    console.log(`  ${s.address.street}, ${s.address.zip} ${s.address.city}`);
    console.log(`  ${entry.clearances.length} product(s):`);
    for (const item of entry.clearances) {
      console.log(formatItem(item));
    }
  }
}

function formatStore(data: any) {
  const s = data.store;
  console.log(`\n${s.name} (${s.brand})`);
  console.log(`  ${s.address.street}, ${s.address.zip} ${s.address.city}`);
  console.log(`  ${data.clearances.length} product(s):`);
  for (const item of data.clearances) {
    console.log(formatItem(item));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) printUsage();

  const json = hasFlag(args, "--json");

  if (command === "search") {
    const location = args[1];
    if (!location) {
      console.error("Error: missing <location>");
      printUsage();
    }
    const radiusStr = getFlagValue(args, "--radius");
    const params: Record<string, any> = { location };
    if (radiusStr) params.radius = parseFloat(radiusStr);

    const result = await tools.search_food_waste.handler(params);
    const data = JSON.parse(result.content[0].text);

    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      formatSearch(data);
    }
  } else if (command === "store") {
    const storeId = args[1];
    if (!storeId) {
      console.error("Error: missing <storeId>");
      printUsage();
    }

    const result = await tools.get_store_food_waste.handler({ storeId });
    const data = JSON.parse(result.content[0].text);

    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      formatStore(data);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
