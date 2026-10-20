// https://www.secretcollectionbd.com/sitemap.xml — every product page, for Google
const SITE = 'https://www.secretcollectionbd.com';
export async function onRequest(ctx) {
  let list = [];
  try { list = await (await ctx.env.ASSETS.fetch(new Request(new URL('/products.json', ctx.request.url)))).json(); } catch (e) {}
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`<url><loc>${SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...(Array.isArray(list) ? list : []).filter(p => p && p.id && p.active !== false)
      .map(p => `<url><loc>${SITE}/p/${encodeURIComponent(p.id)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`)];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
