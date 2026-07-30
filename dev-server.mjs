// Local-only dev server: static file serving + the same two proxy routes as api/*.js,
// so the board behaves identically to Vercel without needing `vercel dev`.
// No dependencies beyond Node's built-ins.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8934;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

function proxyJson(upstreamUrl, res) {
  https
    .get(upstreamUrl, (upstreamRes) => {
      let data = '';
      upstreamRes.on('data', (chunk) => (data += chunk));
      upstreamRes.on('end', () => {
        res.writeHead(upstreamRes.statusCode || 200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    })
    .on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream fetch failed', detail: String(err) }));
    });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/adsb') {
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');
    const radius = url.searchParams.get('radius');
    if (!lat || !lon || !radius) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'lat, lon, radius are required' }));
      return;
    }
    proxyJson(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`, res);
    return;
  }

  if (url.pathname === '/api/route') {
    const callsign = url.searchParams.get('callsign');
    if (!callsign) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'callsign is required' }));
      return;
    }
    proxyJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, res);
    return;
  }

  if (url.pathname === '/api/geocode') {
    const zip = url.searchParams.get('zip');
    if (!zip || !/^\d{5}$/.test(zip)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'zip must be a 5-digit US ZIP code' }));
      return;
    }
    proxyJson(`https://api.zippopotam.us/us/${zip}`, res);
    return;
  }

  if (url.pathname === '/api/logo') {
    const iata = url.searchParams.get('iata');
    if (!iata) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'iata is required' }));
      return;
    }
    const PLACEHOLDER_BYTES = 3103;
    https
      .get(`https://images.kiwi.com/airlines/64/${encodeURIComponent(iata)}.png`, (upstreamRes) => {
        // Follow the redirect kiwi always issues (real logo or its placeholder).
        if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
          https.get(upstreamRes.headers.location, (finalRes) => {
            const chunks = [];
            finalRes.on('data', (c) => chunks.push(c));
            finalRes.on('end', () => {
              const buf = Buffer.concat(chunks);
              if (finalRes.statusCode !== 200 || buf.length === PLACEHOLDER_BYTES) {
                res.writeHead(404);
                res.end();
                return;
              }
              res.writeHead(200, {
                'Content-Type': 'image/png',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400',
              });
              res.end(buf);
            });
          }).on('error', () => { res.writeHead(502); res.end(); });
          return;
        }
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (upstreamRes.statusCode !== 200 || buf.length === PLACEHOLDER_BYTES) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(buf);
        });
      })
      .on('error', () => { res.writeHead(502); res.end(); });
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(ROOT, filePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Flight board dev server running at http://localhost:${PORT}`);
});
