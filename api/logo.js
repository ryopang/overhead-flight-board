// Vercel serverless function: proxies airline logo images from images.kiwi.com
// (free, keyless, keyed by 2-letter IATA airline code). Proxied — like the other
// three upstreams — for one consistent same-origin fetch path from the browser,
// and so we can filter out kiwi's "unknown airline" placeholder server-side:
// unknown codes don't 404, they redirect to a fixed placeholder image, detected
// here by its known byte size and turned into a real 404 for the client.
const PLACEHOLDER_BYTES = 3103;

export default async function handler(req, res) {
  const { iata } = req.query;
  if (!iata) {
    res.status(400).json({ error: 'iata is required' });
    return;
  }
  try {
    const upstream = await fetch(`https://images.kiwi.com/airlines/64/${encodeURIComponent(iata)}.png`);
    if (!upstream.ok) {
      res.status(404).end();
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length === PLACEHOLDER_BYTES) {
      res.status(404).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // logos don't change; safe to cache a day
    res.status(200).send(buf);
  } catch (err) {
    res.status(502).json({ error: 'upstream fetch failed', detail: String(err) });
  }
}
