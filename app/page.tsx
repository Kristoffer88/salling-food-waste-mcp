"use client";

import { useState } from "react";

interface Offer {
  currency: string;
  discount: number;
  newPrice: number;
  originalPrice: number;
  percentDiscount: number;
  stock: number;
  stockUnit: string;
}

interface Product {
  description: string;
  ean: string;
  image?: string;
}

interface Clearance {
  offer: Offer;
  product: Product;
}

interface StoreAddress {
  city: string;
  street: string;
  zip: string;
}

interface Store {
  id: string;
  name: string;
  address: StoreAddress;
  brand: string;
}

interface StoreData {
  store: Store;
  clearances: Clearance[];
}

export default function Home() {
  const [zip, setZip] = useState("8000");
  const [stores, setStores] = useState<StoreData[]>([]);
  const [selectedStore, setSelectedStore] = useState<StoreData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function search() {
    setLoading(true);
    setError("");
    setSelectedStore(null);
    try {
      const res = await fetch(`/api/food-waste?zip=${encodeURIComponent(zip)}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Error ${res.status}`);
      }
      const data: StoreData[] = await res.json();
      setStores(data);
      if (data.length === 0) setError("Ingen butikker fundet for dette postnummer.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Noget gik galt");
      setStores([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadStore(storeId: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/food-waste?storeId=${encodeURIComponent(storeId)}`);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data: StoreData = await res.json();
      setSelectedStore(data);
    } catch {
      setError("Kunne ikke hente butiksdata");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-stone-200 dark:border-stone-800">
        <div className="mx-auto max-w-4xl px-4 py-6">
          <h1 className="text-2xl font-bold tracking-tight">
            MadSpild
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Find nedsatte varer i Salling Group butikker
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        {/* Search */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
          className="flex gap-3"
        >
          <input
            type="text"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            placeholder="Postnummer (f.eks. 8000)"
            className="flex-1 rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 dark:border-stone-700 dark:bg-stone-900"
          />
          <button
            type="submit"
            disabled={loading || !zip.trim()}
            className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50 dark:hover:bg-green-500"
          >
            {loading ? "Søger..." : "Søg"}
          </button>
        </form>

        {error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* Store detail view */}
        {selectedStore && (
          <div className="mt-8">
            <button
              onClick={() => setSelectedStore(null)}
              className="mb-4 text-sm text-accent hover:underline"
            >
              &larr; Tilbage til oversigt
            </button>
            <div className="rounded-xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
              <div className="mb-1 text-xs font-medium uppercase tracking-wider text-stone-400">
                {selectedStore.store.brand}
              </div>
              <h2 className="text-xl font-semibold">
                {selectedStore.store.name}
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                {selectedStore.store.address.street},{" "}
                {selectedStore.store.address.zip}{" "}
                {selectedStore.store.address.city}
              </p>
              <p className="mt-2 text-sm text-stone-500">
                {selectedStore.clearances.length} nedsatte varer
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {selectedStore.clearances.map((item, i) => (
                  <ProductCard key={i} item={item} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Store list */}
        {!selectedStore && stores.length > 0 && (
          <div className="mt-8 space-y-4">
            <p className="text-sm text-stone-500">
              {stores.length} butik{stores.length !== 1 && "ker"} fundet
            </p>
            {stores.map((store) => (
              <button
                key={store.store.id}
                onClick={() => loadStore(store.store.id)}
                className="w-full rounded-xl border border-stone-200 bg-white p-5 text-left transition-colors hover:border-accent/40 hover:bg-accent-light/30 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-accent/40"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wider text-stone-400">
                      {store.store.brand}
                    </div>
                    <h3 className="mt-0.5 font-semibold">{store.store.name}</h3>
                    <p className="mt-1 text-sm text-stone-500">
                      {store.store.address.street},{" "}
                      {store.store.address.zip}{" "}
                      {store.store.address.city}
                    </p>
                  </div>
                  <div className="shrink-0 rounded-full bg-accent-light px-3 py-1 text-sm font-medium text-accent">
                    {store.clearances.length} varer
                  </div>
                </div>

                {/* Preview: top 3 products */}
                {store.clearances.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {store.clearances.slice(0, 3).map((item, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-2.5 py-1 text-xs dark:bg-stone-800"
                      >
                        <span className="truncate max-w-[150px]">
                          {item.product.description}
                        </span>
                        <span className="font-semibold text-accent">
                          {item.offer.newPrice} kr
                        </span>
                      </span>
                    ))}
                    {store.clearances.length > 3 && (
                      <span className="inline-flex items-center rounded-md bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-stone-800">
                        +{store.clearances.length - 3} mere
                      </span>
                    )}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ProductCard({ item }: { item: Clearance }) {
  const pct = Math.round(
    ((item.offer.originalPrice - item.offer.newPrice) / item.offer.originalPrice) * 100
  );

  return (
    <div className="flex items-center gap-3 rounded-lg border border-stone-100 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-800/50">
      {item.product.image && (
        <img
          src={item.product.image}
          alt={item.product.description}
          className="h-14 w-14 rounded-md object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {item.product.description}
        </p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-sm font-bold text-accent">
            {item.offer.newPrice} kr
          </span>
          <span className="text-xs text-stone-400 line-through">
            {item.offer.originalPrice} kr
          </span>
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
            -{pct}%
          </span>
        </div>
      </div>
    </div>
  );
}
