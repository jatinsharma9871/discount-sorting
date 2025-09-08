// /api/products.js

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2024-07";
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

const endpoint = `https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`;

async function gqlFetch(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Shopify-Storefront-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify error: ${res.status} ${res.statusText} :: ${text}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// … keep your COLLECTION_QUERY, SEARCH_QUERY, mapProduct, collectCandidates etc.

export default async function handler(req, res) {
  // Quick env check route
  if (req.query.check === "env") {
    return res.status(200).json({
      STORE_DOMAIN,
      TOKEN_PRESENT: !!TOKEN,
    });
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!STORE_DOMAIN || !TOKEN) {
      return res.status(500).json({ error: "Missing Shopify env vars" });
    }

    const { collection, query, limit: limitParam, factor: factorParam } = req.query;
    const limit = Math.min(Math.max(parseInt(limitParam || "50", 10), 1), 250);
    const factor = Math.min(Math.max(parseInt(factorParam || "2", 10), 1), 6);

    if (!collection && !query) {
      return res.status(400).json({ error: "Provide ?collection=handle or ?query=term" });
    }

    const rawNodes = await collectCandidates({ collection: collection || null, query: query || null, limit, factor });
    const mapped = rawNodes.map(mapProduct).filter(p => p.maxDiscount > 0);
    mapped.sort((a, b) => b.maxDiscount - a.maxDiscount);
    const top = mapped.slice(0, limit);

    return res.status(200).json({
      meta: { collection: collection || null, query: query || null, limit, factor },
      products: top,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error", detail: String(err.message || err) });
  }
}
