// Vercel serverless function: proxies adsb.lol position lookups (blocked by CORS for direct browser fetch).
export default async function handler(req, res) {
  const { lat, lon, radius } = req.query;
  if (!lat || !lon || !radius) {
    res.status(400).json({ error: 'lat, lon, radius are required' });
    return;
  }
  try {
    const upstream = await fetch(
      `https://api.adsb.lol/v2/point/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}/${encodeURIComponent(radius)}`,
      // api.adsb.lol now rejects requests with a generic/default User-Agent
      // (the runtime's default) with a 403 — it requires an identifying UA.
      { headers: { 'User-Agent': 'OverheadFlightBoard/1.0 (local personal flight tracker)' } }
    );
    const body = await upstream.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'upstream fetch failed', detail: String(err) });
  }
}
