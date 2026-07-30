// Vercel serverless function: resolves a US ZIP code to lat/lon via zippopotam.us
// (free, keyless, US Census-derived data). Proxied for the same reason as the other
// two upstreams — one consistent client-side fetch path, one place to add caching later.
export default async function handler(req, res) {
  const { zip } = req.query;
  if (!zip || !/^\d{5}$/.test(zip)) {
    res.status(400).json({ error: 'zip must be a 5-digit US ZIP code' });
    return;
  }
  try {
    const upstream = await fetch(`https://api.zippopotam.us/us/${zip}`);
    const body = await upstream.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'upstream fetch failed', detail: String(err) });
  }
}
