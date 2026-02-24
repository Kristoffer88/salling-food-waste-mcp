import { NextRequest, NextResponse } from "next/server";

const API_BASE = "https://api.sallinggroup.com";
const API_KEY = process.env.SALLING_API_KEY;

export async function GET(request: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json(
      { error: "API key not configured" },
      { status: 500 }
    );
  }

  const { searchParams } = request.nextUrl;
  const zip = searchParams.get("zip");
  const storeId = searchParams.get("storeId");

  let url: string;
  if (storeId) {
    url = `${API_BASE}/v1/food-waste/${encodeURIComponent(storeId)}`;
  } else if (zip) {
    url = `${API_BASE}/v1/food-waste/?zip=${encodeURIComponent(zip)}`;
  } else {
    return NextResponse.json(
      { error: "Provide ?zip= or ?storeId= parameter" },
      { status: 400 }
    );
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: `Salling API error: ${res.status} ${res.statusText}` },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}
