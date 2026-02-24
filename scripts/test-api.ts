import "dotenv/config";

const API_BASE = "https://api.sallinggroup.com";
const API_KEY = process.env.SALLING_API_KEY;

if (!API_KEY) {
  console.error("Missing SALLING_API_KEY in .env");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}` };

async function fetchJSON(url: string) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function testZipSearch(zip = "8000") {
  console.log(`\n=== Search by ZIP: ${zip} ===`);
  const data = await fetchJSON(`${API_BASE}/v1/food-waste/?zip=${zip}`);
  console.log(`Found ${data.length} store(s)`);
  for (const store of data.slice(0, 3)) {
    console.log(`\n  Store: ${store.store.name} (${store.store.id})`);
    console.log(`  Address: ${store.store.address.street}, ${store.store.address.zip} ${store.store.address.city}`);
    console.log(`  Products: ${store.clearances.length}`);
    for (const item of store.clearances.slice(0, 3)) {
      const pct = Math.round((1 - item.offer.newPrice / item.offer.originalPrice) * 100);
      console.log(`    - ${item.product.description}: ${item.offer.originalPrice} kr → ${item.offer.newPrice} kr (${pct}% off)`);
    }
  }
  return data;
}

async function testGeoSearch(lat = 56.1629, lon = 10.2039, radius = 5) {
  console.log(`\n=== Search by geo: ${lat},${lon} radius ${radius}km ===`);
  const data = await fetchJSON(
    `${API_BASE}/v1/food-waste/?geo=${lat},${lon}&radius=${radius}`
  );
  console.log(`Found ${data.length} store(s)`);
  for (const store of data.slice(0, 2)) {
    console.log(`  Store: ${store.store.name} — ${store.clearances.length} products`);
  }
  return data;
}

async function testSingleStore(storeId: string) {
  console.log(`\n=== Single store: ${storeId} ===`);
  const data = await fetchJSON(`${API_BASE}/v1/food-waste/${storeId}`);
  console.log(`  Store: ${data.store.name}`);
  console.log(`  Products: ${data.clearances.length}`);
  for (const item of data.clearances.slice(0, 5)) {
    console.log(`    - ${item.product.description}: ${item.offer.newPrice} kr`);
  }
  return data;
}

async function main() {
  console.log("Salling Food Waste API — Test Script");
  console.log("=====================================");

  // 1. Search by ZIP
  const zipData = await testZipSearch("8000");

  // 2. Search by geo (Aarhus center)
  await testGeoSearch();

  // 3. Single store (use first store from ZIP search)
  if (zipData.length > 0) {
    await testSingleStore(zipData[0].store.id);
  } else {
    console.log("\nSkipping single-store test — no stores from ZIP search");
  }

  console.log("\n✓ All tests passed");
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err.message);
  process.exit(1);
});
