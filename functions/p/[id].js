// Secret Collection BD — shareable product pages: https://www.secretcollectionbd.com/p/L01
// Facebook, Messenger, WhatsApp and Google read the product's own title, photo, price and description from here.
// Shoppers get the normal website, which opens straight on that product.
const SITE = 'https://www.secretcollectionbd.com';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const id = decodeURIComponent(String(ctx.params.id || '')).trim();
  const page = await ctx.env.ASSETS.fetch(new Request(new URL('/', url)));
  let list = [];
  try { list = await (await ctx.env.ASSETS.fetch(new Request(new URL('/products.json', url)))).json(); } catch (e) {}
  const p = (Array.isArray(list) ? list : []).find(x => x && String(x.id).toUpperCase() === id.toUpperCase() && x.active !== false);
  const headers = new Headers(page.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300');
  if (!p) {
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(page.body, { status: 404, headers });
  }
  const img = p.image || (Array.isArray(p.images) && p.images[0]) || 'image0.jpg';
  const imgUrl = /^https?:/.test(img) ? img : `${SITE}/${String(img).replace(/^\/+/, '')}`;
  const price = Math.round(Number(p.price) || 0);
  const pageUrl = `${SITE}/p/${encodeURIComponent(p.id)}`;
  const title = `${p.name} | Secret Collection BD`;
  const desc = `৳${price.toLocaleString('en-IN')} · ${p.category || 'Lingerie'} · ${String(p.description || 'Luxury intimate wear with private, discreet delivery across Bangladesh.').slice(0, 150)}`;
  const soldOut = Array.isArray(p.soldOut) && Array.isArray(p.sizes) && p.sizes.length && p.sizes.every(s => p.soldOut.includes(s));
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.id, image: [imgUrl], description: p.description || desc, category: p.category,
    brand: { '@type': 'Brand', name: 'Secret Collection BD' },
    offers: { '@type': 'Offer', url: pageUrl, priceCurrency: 'BDT', price, availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock' } };
  const set = (sel, attr, val) => ({ selector: sel, h: { element(e) { e.setAttribute(attr, val); } } });
  const rules = [
    set('meta[name="description"]', 'content', desc),
    set('meta[property="og:title"]', 'content', title),
    set('meta[property="og:description"]', 'content', desc),
    set('meta[property="og:image"]', 'content', imgUrl),
    set('meta[property="og:url"]', 'content', pageUrl),
    set('meta[property="og:type"]', 'content', 'product'),
    set('meta[name="twitter:title"]', 'content', title),
    set('meta[name="twitter:description"]', 'content', desc),
    set('meta[name="twitter:image"]', 'content', imgUrl),
    set('link[rel="canonical"]', 'href', pageUrl),
  ];
  let rw = new HTMLRewriter().on('title', { element(e) { e.setInnerContent(title); } });
  rules.forEach(r => { rw = rw.on(r.selector, r.h); });
  rw = rw.on('head', { element(e) {
    e.append(`<meta property="product:price:amount" content="${price}" /><meta property="product:price:currency" content="BDT" />` +
      `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`, { html: true });
  } });
  return rw.transform(new Response(page.body, { status: 200, headers }));
}
