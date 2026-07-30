// Vercel serverless function: proxies adsbdb.com route lookups.
// adsbdb.com already sends Access-Control-Allow-Origin: *, but we route it through
// the same origin as /api/adsb for a single consistent client-side fetch path.
export default async function handler(req, res) {
  const { callsign } = req.query;
  if (!callsign) {
    res.status(400).json({ error: 'callsign is required' });
    return;
  }
  try {
    const upstream = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`);
    const body = await upstream.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'upstream fetch failed', detail: String(err) });
  }
}
