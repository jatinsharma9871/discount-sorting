// /api/products.js
// Vercel serverless function for Shopify discounted products API

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2024-07";
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

const endpoint = `https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`;

async function gqlFetch(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
   headers: {
  "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
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

const COLLECTION_QUERY = `
  query CollectionProducts($handle: String!, $cursor: String) {
    collectionByHandle(handle: $handle) {
      id
      title
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          handle
          title
          onlineStoreUrl
          featuredImage { url altText }
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variants(first: 100) {
            nodes {
              id
              title
              price { amount currencyCode }
              compareAtPrice { amount currencyCode }
            }
          }
        }
      }
    }
  }
`;

const SEARCH_QUERY = `
  query SearchProducts($query: String!, $cursor: String) {
    products(query: $query, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        onlineStoreUrl
        featuredImage { url altText }
        priceRange {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 100) {
          nodes {
            id
            title
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

function computeMaxDiscount(productNode) {
  let maxPct = 0;
  const variants = productNode.variants?.nodes || [];
  for (const v of variants) {
    const price = parseFloat(v.price?.amount || "0");
    const compare = parseFloat(v.compareAtPrice?.amount || "0");
    if (compare > price && compare > 0) {
      const pct = Math.round(((compare - price) / compare) * 100);
      if (pct > maxPct) maxPct = pct;
    }
  }
  return maxPct;
}

function mapProduct(node) {
  const variants = (node.variants?.nodes || []).map(v => ({
    id: v.id,
    title: v.title,
    price: parseFloat(v.price?.amount || "0"),
    compare_at_price: v.compareAtPrice ? parseFloat(v.compareAtPrice.amount || "0") : null,
    currency: v.price?.currencyCode || null,
  }));

  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    url: node.onlineStoreUrl || `https://${STORE_DOMAIN}/products/${node.handle}`,
    image: node.featuredImage?.url || null,
    image_alt: node.featuredImage?.altText || null,
    price_min: parseFloat(node.priceRange?.minVariantPrice?.amount || "0"),
    price_max: parseFloat(node.priceRange?.maxVariantPrice?.amount || "0"),
    currency: node.priceRange?.minVariantPrice?.currencyCode || null,
    variants,
    maxDiscount: computeMaxDiscount(node),
  };
}

async function collectCandidates({ collection, query, limit, factor = 2 }) {
  let hasNext = true;
  let cursor = null;
  const out = [];

  while (hasNext && out.length < limit * factor) {
    if (collection) {
      const data = await gqlFetch(COLLECTION_QUERY, { handle: collection, cursor });
      const col = data.collectionByHandle;
      if (!col) break;
      const page = col.products;
      out.push(...page.nodes);
      hasNext = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    } else {
      const data = await gqlFetch(SEARCH_QUERY, { query, cursor });
      const page = data.products;
      out.push(...page.nodes);
      hasNext = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }
  }

  return out;
}

export default async function handler(req, res) {
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
