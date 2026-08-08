// app.js — polling loop, filtering/sorting, route enrichment + caching, rendering, resilience.

const CONFIG = {
  DEFAULT_ZIP: '07020',
  DEFAULT_LAT: 40.8256, // Edgewater, NJ — used until a zip resolves, and as a hard fallback
  DEFAULT_LON: -73.9765,
  DEFAULT_RADIUS_MI: 25, // "overhead" search radius for the flip board — user-configurable
  MIN_RADIUS_MI: 1,
  MAX_RADIUS_MI: 50,
  RADIUS_STEP_MI: 1,
  MAP_RADIUS_MI: 5, // the map's fixed zoom extent — unrelated to the search radius above
  DEFAULT_FLIP_INTERVAL_MS: 60000, // how often the board refreshes/flips; user-configurable
  MIN_FLIP_INTERVAL_MS: 15000, // adsb.lol courtesy floor — never poll faster than this
  ROUTE_CACHE_TTL_MS: 15 * 60 * 1000,
  MIN_ROWS: 1,
  MAX_ROWS: 10, // hard cap — the board pre-builds this many row DOM instances
  DEFAULT_ROWS: 5,
  BACKOFF_START_MS: 5000,
  BACKOFF_MAX_MS: 60000,
};

const STORAGE_KEYS = {
  flipInterval: 'overhead:flipIntervalMs',
  muted: 'overhead:muted',
  rowCount: 'overhead:rowCount',
  zip: 'overhead:zip',
  radiusMi: 'overhead:radiusMi',
  mapEnabled: 'overhead:mapEnabled',
  mapEnabledSingle: 'overhead:mapEnabledSingle',
  displayMode: 'overhead:displayMode',
};

function loadDisplayMode() {
  return localStorage.getItem(STORAGE_KEYS.displayMode) === 'single' ? 'single' : 'board';
}

function loadFlipInterval() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.flipInterval));
  return stored >= CONFIG.MIN_FLIP_INTERVAL_MS ? stored : CONFIG.DEFAULT_FLIP_INTERVAL_MS;
}

function loadMuted() {
  return localStorage.getItem(STORAGE_KEYS.muted) === 'true';
}

function loadRowCount() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.rowCount));
  return stored >= CONFIG.MIN_ROWS && stored <= CONFIG.MAX_ROWS ? stored : CONFIG.DEFAULT_ROWS;
}

function loadZip() {
  const stored = localStorage.getItem(STORAGE_KEYS.zip);
  return stored && /^\d{5}$/.test(stored) ? stored : CONFIG.DEFAULT_ZIP;
}

function loadRadiusMi() {
  const stored = Number(localStorage.getItem(STORAGE_KEYS.radiusMi));
  return stored >= CONFIG.MIN_RADIUS_MI && stored <= CONFIG.MAX_RADIUS_MI ? stored : CONFIG.DEFAULT_RADIUS_MI;
}

const MI_PER_NM = 1.15078;

// Current tracking location — mutable, changed via the ZIP setting. Starts at the
// Edgewater default; main() overwrites it once the stored/default zip geocodes.
const trackingLocation = { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON };

// Current "overhead" search radius in miles — mutable, changed via the RADIUS setting.
let searchRadiusMi = CONFIG.DEFAULT_RADIUS_MI;

/** Resolve a 5-digit US ZIP to {lat, lon, label} via the geocode proxy (zippopotam.us). */
async function geocodeZip(zip) {
  const res = await fetch(`/api/geocode?zip=${encodeURIComponent(zip)}`);
  if (!res.ok) throw new Error(`zip not found`);
  const json = await res.json();
  const place = json.places && json.places[0];
  if (!place) throw new Error('zip not found');
  return {
    lat: Number(place.latitude),
    lon: Number(place.longitude),
    label: `${place['place name']}, ${place['state abbreviation']}`.toUpperCase(),
  };
}

const FIELD_WIDTHS = { flight: 7, airline: 18, route: 7, eta: 5 };

// ICAO aircraft type designator -> friendly model name, for the single-flight view's
// "737-900" style line. adsb.lol gives us the ICAO code (ac.t) directly; adsbdb/
// airports.json don't carry a friendly name, so this is a small local lookup table
// covering common airline fleet types rather than pulling in another API. Unknown
// codes just fall back to the raw ICAO designator.
const AIRCRAFT_TYPE_NAMES = {
  B737: '737-700', B738: '737-800', B739: '737-900', B37M: '737 MAX 7', B38M: '737 MAX 8', B39M: '737 MAX 9',
  B752: '757-200', B753: '757-300', B762: '767-200', B763: '767-300', B764: '767-400',
  B772: '777-200', B77L: '777-200LR', B773: '777-300', B77W: '777-300ER',
  B788: '787-8', B789: '787-9', B78X: '787-10',
  A319: 'A319', A320: 'A320', A321: 'A321', A20N: 'A320neo', A21N: 'A321neo', A318: 'A318',
  A332: 'A330-200', A333: 'A330-300', A339: 'A330-900neo', A359: 'A350-900', A35K: 'A350-1000', A388: 'A380-800',
  CRJ2: 'CRJ-200', CRJ7: 'CRJ-700', CRJ9: 'CRJ-900', CRJX: 'CRJ-1000',
  E145: 'ERJ-145', E170: 'E170', E75L: 'E175', E75S: 'E175', E190: 'E190', E195: 'E195',
  DH8D: 'Dash 8-400',
};

function formatAircraftType(icaoType) {
  if (!icaoType) return null;
  const code = icaoType.trim().toUpperCase();
  return AIRCRAFT_TYPE_NAMES[code] || code;
}

// Strips the generic "International Airport" / "Airport" suffix so a route lookup's
// full destination name reads like a departure-sign line, e.g. "Phoenix Sky Harbor
// International Airport" -> "Phoenix Sky Harbor".
function formatAirportName(name) {
  if (!name) return null;
  return name.replace(/\s+International Airport$/i, '').replace(/\s+Airport$/i, '').trim();
}

// ---------------- Airport coordinates (for arrival-time estimate) ----------------
//
// Neither adsb.lol nor adsbdb.com provides a scheduled/estimated arrival time —
// that data lives behind paid flight-schedule APIs, which are out of scope here.
// Instead: bundle a static, free (public-domain-sourced) IATA -> lat/lon table,
// and estimate ETA as great-circle distance from the aircraft's *current* position
// to its destination airport, divided by its *current* ground speed. This is a
// rough estimate (a climbing or holding aircraft won't be flying a great-circle
// path yet), shown as such — not a real scheduled arrival time.

let airportCoords = null; // IATA -> {lat, lon}, loaded once

async function loadAirportCoords() {
  try {
    const res = await fetch('/airports.json');
    if (!res.ok) throw new Error(`airports.json ${res.status}`);
    airportCoords = await res.json();
  } catch {
    airportCoords = {}; // ETA will fall back to "--:--" for every row
  }
}

const EARTH_RADIUS_NM = 3440.065;

function greatCircleNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ETA_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Estimated arrival time in EST/EDT ("14:32"), or "--:--" if it can't be computed. */
function estimateArrival(ac, destinationIata) {
  const dest = airportCoords && airportCoords[destinationIata];
  const gs = ac.gs;
  if (!dest || !gs || gs < 30 || ac.lat == null || ac.lon == null) return '--:--';
  const distNm = greatCircleNm(ac.lat, ac.lon, dest.lat, dest.lon);
  const etaHours = distNm / gs;
  if (!Number.isFinite(etaHours) || etaHours > 20) return '--:--'; // sanity cap
  const etaDate = new Date(Date.now() + etaHours * 3600 * 1000);
  return ETA_TIME_FORMAT.format(etaDate);
}

// ---------------- Route cache ----------------

const routeCache = new Map(); // callsign -> { data: routeInfoOrNull, ts }

async function resolveRoute(callsign) {
  const cached = routeCache.get(callsign);
  if (cached && Date.now() - cached.ts < CONFIG.ROUTE_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const res = await fetch(`/api/route?callsign=${encodeURIComponent(callsign)}`);
    if (!res.ok) throw new Error(`route lookup ${res.status}`);
    const json = await res.json();
    const fr = json && json.response && json.response.flightroute;
    const data = fr
      ? {
          airline: (fr.airline && fr.airline.name) || 'UNKNOWN',
          iata: fr.airline && fr.airline.iata,
          countryIso: fr.airline && fr.airline.country_iso,
          origin: (fr.origin && fr.origin.iata_code) || '---',
          destination: (fr.destination && fr.destination.iata_code) || '---',
          destinationName: (fr.destination && fr.destination.name) || null,
          destinationMunicipality: (fr.destination && fr.destination.municipality) || null,
        }
      : null;
    routeCache.set(callsign, { data, ts: Date.now() });
    return data;
  } catch {
    // Don't cache network failures — only cache confirmed "no route" results.
    return null;
  }
}

// ---------------- Airline logos ----------------
//
// Neither locked API provides logos. images.kiwi.com is a free, keyless image CDN
// keyed by 2-letter IATA airline code, commonly used by hobby flight projects —
// proxied through /api/logo (same reasoning as the other three upstreams: one
// consistent same-origin fetch path). The proxy also filters out kiwi's "unknown
// airline" placeholder image server-side and returns a plain 404 instead, so an
// unrecognized code just leaves the logo blank.

const logoCache = new Map(); // iata -> objectURL string | null

async function resolveLogo(iata) {
  if (!iata) return null;
  if (logoCache.has(iata)) return logoCache.get(iata);
  try {
    const res = await fetch(`/api/logo?iata=${encodeURIComponent(iata)}`);
    if (!res.ok) {
      logoCache.set(iata, null);
      return null;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    logoCache.set(iata, url);
    return url;
  } catch {
    logoCache.set(iata, null);
    return null;
  }
}

// ---------------- Position fetch + filtering ----------------

async function fetchPositions() {
  const radiusNm = searchRadiusMi / MI_PER_NM;
  const res = await fetch(`/api/adsb?lat=${trackingLocation.lat}&lon=${trackingLocation.lon}&radius=${radiusNm}`);
  if (!res.ok) throw new Error(`adsb fetch ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.ac) ? json.ac : [];
}

function looksLikeAirlineCallsign(raw) {
  const flight = (raw || '').trim();
  if (!flight) return false;
  return /^[A-Z]{2,4}\d{1,5}[A-Z]?$/i.test(flight);
}

function filterAndSort(aircraft) {
  return aircraft
    .filter((ac) => ac.alt_baro !== 'ground' && ac.alt_baro !== undefined && ac.alt_baro !== null)
    .filter((ac) => looksLikeAirlineCallsign(ac.flight))
    .map((ac) => ({ ...ac, flight: ac.flight.trim() }))
    .sort((a, b) => (a.dst ?? Infinity) - (b.dst ?? Infinity));
}

/** Build up to `rowCount` resolved rows, backfilling from next-nearest when a route fails to resolve. */
async function buildBoard(candidates, rowCount) {
  const rows = [];
  let i = 0;
  while (rows.length < rowCount && i < candidates.length) {
    const ac = candidates[i];
    i++;
    const route = await resolveRoute(ac.flight);
    if (!route) continue; // GA / unresolved — drop and backfill from next candidate
    const logoUrl = await resolveLogo(route.iata);
    rows.push({
      flight: ac.flight,
      airline: route.airline,
      route: `${route.origin}→${route.destination}`,
      eta: estimateArrival(ac, route.destination),
      isUS: route.countryIso === 'US',
      logoUrl,
      lat: ac.lat,
      lon: ac.lon,
      track: ac.dir,
      type: formatAircraftType(ac.t),
      destinationAirportName: formatAirportName(route.destinationName),
      destinationCity: route.destinationMunicipality || null,
      altitudeFt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
      groundSpeedKt: typeof ac.gs === 'number' ? ac.gs : null,
    });
  }
  return rows;
}

// ---------------- 7-segment clock ----------------

const SEGMENTS = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  ' ': '',
};

function buildSevenSegDigit(container) {
  const digit = document.createElement('div');
  digit.className = 'seg-digit';
  const segs = {};
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    const el = document.createElement('div');
    el.className = `seg seg-${s}`;
    digit.appendChild(el);
    segs[s] = el;
  }
  container.appendChild(digit);
  return {
    set(ch) {
      const on = new Set((SEGMENTS[ch] || '').split(''));
      for (const s of Object.keys(segs)) {
        segs[s].classList.toggle('on', on.has(s));
      }
    },
  };
}

function initClock(container) {
  const h1 = buildSevenSegDigit(container);
  const h2 = buildSevenSegDigit(container);
  const colon = document.createElement('div');
  colon.className = 'seg-colon';
  colon.innerHTML = '<span class="dot"></span><span class="dot"></span>';
  container.appendChild(colon);
  const m1 = buildSevenSegDigit(container);
  const m2 = buildSevenSegDigit(container);

  function tick() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    h1.set(hh[0]);
    h2.set(hh[1]);
    m1.set(mm[0]);
    m2.set(mm[1]);
  }
  tick();
  setInterval(tick, 1000);
}

// ---------------- Board rendering ----------------

class BoardRow {
  constructor(container) {
    this.el = document.createElement('div');
    this.el.className = 'flap-row';
    this.el.innerHTML = `
      <div class="field field-flight"><span class="us-tag">US</span><span class="field-cells"></span></div>
      <div class="field field-airline"><span class="airline-logo"><img class="airline-logo-img" alt="" /></span><span class="field-cells"></span></div>
      <div class="field field-route"></div>
      <div class="field field-eta"></div>
    `;
    container.appendChild(this.el);

    this.flightField = new FlapField(this.el.querySelector('.field-flight .field-cells'), FIELD_WIDTHS.flight);
    this.airlineField = new FlapField(this.el.querySelector('.field-airline .field-cells'), FIELD_WIDTHS.airline);
    this.routeField = new FlapField(this.el.querySelector('.field-route'), FIELD_WIDTHS.route);
    this.etaField = new FlapField(this.el.querySelector('.field-eta'), FIELD_WIDTHS.eta);
    this.logoImg = this.el.querySelector('.airline-logo-img');
  }

  setData(row, onClack) {
    this.el.classList.toggle('is-us', !!(row && row.isUS));
    this.flightField.setValue(row ? row.flight : '', onClack);
    this.airlineField.setValue(row ? row.airline : '', onClack);
    this.routeField.setValue(row ? row.route : '', onClack);
    this.etaField.setValue(row ? row.eta : '', onClack);
    if (row && row.logoUrl) {
      this.logoImg.src = row.logoUrl;
      this.logoImg.classList.add('is-loaded');
    } else {
      this.logoImg.classList.remove('is-loaded');
      this.logoImg.removeAttribute('src');
    }
  }
}

// ---------------- Single-flight view ----------------
//
// Alternate to the split-flap board, selectable via Settings > VIEW. Shows just
// the nearest overhead flight (rows[0] from the same poll loop that feeds the
// board) as a departure-sign-style card. Purely a second renderer over the same
// data — doesn't touch board rendering or polling.

// The logo box renders as a dot-matrix grid (round dots, sampled from the source
// image's alpha) rather than a plain <img>, so it reads as part of the same
// LED-sign material as the .dot-font text next to it instead of a smooth bitmap
// dropped into a pixelated scene.

// 44x44 (up from an earlier 20x20, before that 14x14) — logos with fine detail
// (e.g. United's globe, a network of thin curved lines) turned into unrecognizable
// blobs at 20x20. Still reads as a dot-matrix grid, just a much denser one, so
// enough structure survives to recognize the actual mark.
const LOGO_DOT_COLS = 44;
const LOGO_DOT_ROWS = 44;

function drawDotMatrixLogo(canvas, source) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Sample the source into a small offscreen canvas first (contain-fit, like
  // object-fit: contain) — that low-res sampling is what produces the dot grid,
  // rather than trying to pixelate at full resolution.
  const off = document.createElement('canvas');
  off.width = LOGO_DOT_COLS;
  off.height = LOGO_DOT_ROWS;
  const octx = off.getContext('2d');
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  if (!srcW || !srcH) return; // broken/zero-size source — leave the canvas cleared
  const fit = Math.min((LOGO_DOT_COLS * 0.86) / srcW, (LOGO_DOT_ROWS * 0.86) / srcH);
  const dw = srcW * fit;
  const dh = srcH * fit;
  octx.drawImage(source, (LOGO_DOT_COLS - dw) / 2, (LOGO_DOT_ROWS - dh) / 2, dw, dh);
  const data = octx.getImageData(0, 0, LOGO_DOT_COLS, LOGO_DOT_ROWS).data;

  // The whole sampled image is dot-matrixed as-is, background chip included —
  // a logo's white (or blue, or whatever) background is part of its actual
  // appearance, not something to strip out. Every cell gets its own true
  // sampled color; only cells outside the contain-fit area (our own padding,
  // fully transparent) are skipped.
  const cellW = w / LOGO_DOT_COLS;
  const cellH = h / LOGO_DOT_ROWS;
  for (let y = 0; y < LOGO_DOT_ROWS; y++) {
    for (let x = 0; x < LOGO_DOT_COLS; x++) {
      const idx = (y * LOGO_DOT_COLS + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3] / 255;
      // Only skip cells that are truly transparent (our own contain-fit padding
      // outside the drawn image, or a genuinely transparent pixel in the
      // source). The earlier, higher cutoff (0.12) was also dropping cells with
      // real but partial coverage — anti-aliased edges, or artifacts from
      // downsampling a much larger source image into this small a grid — which
      // showed up as unlit "holes" inside an otherwise solid area of the logo.
      if (alpha < 0.02) continue;

      const cx = x * cellW + cellW / 2;
      const cy = y * cellH + cellH / 2;
      const radius = (Math.min(cellW, cellH) / 2) * 0.7 * Math.max(alpha, 0.75);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.55 + 0.45 * alpha})`;
      ctx.fill();
    }
  }
}

// Fallback source when a flight has no resolvable airline logo — a plain plane
// glyph, rasterized once and reused as the dot-matrix sampling source so the
// placeholder is made of the same dots as a real logo rather than a smooth SVG.
let planeSilhouetteImg = null;
function getPlaneSilhouette() {
  if (planeSilhouetteImg) return Promise.resolve(planeSilhouetteImg);
  return new Promise((resolve) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<path fill="#ffffff" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
    const img = new Image();
    img.onload = () => {
      planeSilhouetteImg = img;
      resolve(img);
    };
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  });
}

// altitudeFt/groundSpeedKt come straight from adsb.lol's raw ADS-B report
// (alt_baro, gs) — shown only in the single-flight view, formatted like a
// cockpit/ATC readout ("FL350 · 462 KTS").
function formatTelemetry(row) {
  if (!row) return '—';
  const altPart =
    row.altitudeFt != null ? `FL${Math.round(row.altitudeFt / 100)}` : null;
  const spdPart = row.groundSpeedKt != null ? `${Math.round(row.groundSpeedKt)} KTS` : null;
  if (!altPart && !spdPart) return '—';
  return [altPart, spdPart].filter(Boolean).join(' · ');
}

// A long destination name (e.g. "Barnstable Municipal Boardman Polando Field")
// at the CSS clamp's large default size can run past 3 lines and, combined with
// the info block above it, push the whole sign past one screen's height. Rather
// than picking a single small font size that would also shrink ordinary short
// names (most flights), only shrink when the text actually needs it: reset to
// the CSS default, then step the font size down until it fits within 3 lines.
// el.scrollHeight reflects the full unclamped content height (the CSS
// -webkit-line-clamp only affects what's visually painted), so it's a reliable
// measure of how many lines the text would take at the current font size.
const DEST_MIN_FONT_PX = 30;
const DEST_FONT_STEP_PX = 4;

function fitDestinationText(el) {
  el.style.fontSize = '';
  const lineCount = () => {
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 1;
    return Math.round(el.scrollHeight / lineHeight);
  };
  let guard = 0;
  while (lineCount() > 3 && guard < 30) {
    const current = parseFloat(getComputedStyle(el).fontSize);
    const next = current - DEST_FONT_STEP_PX;
    if (next < DEST_MIN_FONT_PX) {
      el.style.fontSize = `${DEST_MIN_FONT_PX}px`;
      break;
    }
    el.style.fontSize = `${next}px`;
    guard++;
  }
}

let singleLogoRequestId = 0;

function updateSingleView(refs, row) {
  refs.flight.textContent = row ? row.flight : '—';
  refs.route.textContent = row ? row.route.replace('→', '-') : '—';
  refs.type.textContent = row && row.type ? row.type : '—';
  refs.telemetry.textContent = formatTelemetry(row);

  const destIata = row ? row.route.split('→')[1] : null;
  const dest = row ? row.destinationAirportName || row.destinationCity || destIata : null;
  refs.dest.textContent = dest || '—';
  fitDestinationText(refs.dest);

  const myRequest = ++singleLogoRequestId;
  const drawPlaneFallback = () => {
    getPlaneSilhouette().then((img) => {
      if (myRequest !== singleLogoRequestId) return;
      drawDotMatrixLogo(refs.logoCanvas, img);
    });
  };
  if (row && row.logoUrl) {
    const img = new Image();
    img.onload = () => {
      if (myRequest !== singleLogoRequestId) return; // superseded by a newer row
      drawDotMatrixLogo(refs.logoCanvas, img);
    };
    img.onerror = () => {
      if (myRequest !== singleLogoRequestId) return;
      drawPlaneFallback();
    };
    img.src = row.logoUrl;
  } else {
    drawPlaneFallback();
  }
}

// ---------------- Map ----------------
//
// Shows the same flights already on the board (still just the ones currently
// overhead, within RADIUS_NM) plotted on a map zoomed out to a MAP_RADIUS_MI-wide
// view of the tracking location — geographic context, not an expanded search.
// Static/non-interactive by design, matching the board's "nothing moves except
// the flip" kiosk philosophy.

const PLANE_PATH_D =
  'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z';

let map = null;
let homeMarker = null;
let radiusCircle = null;
let flightMarkers = new Map(); // flight number -> L.Marker

function milesToLatDegrees(mi) {
  return mi / 69;
}
function milesToLonDegrees(mi, atLat) {
  return mi / (69 * Math.cos((atLat * Math.PI) / 180));
}

function initMap() {
  map = L.map('map', {
    zoomControl: false, // added manually below, positioned top-right
    dragging: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: true,
    attributionControl: true,
  });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
  const radiusLabel = document.getElementById('map-radius-label');
  if (radiusLabel) radiusLabel.textContent = `${CONFIG.MAP_RADIUS_MI}MI RADIUS`;
  recenterMap();
}

function recenterMap() {
  if (!map) return;
  const dLat = milesToLatDegrees(CONFIG.MAP_RADIUS_MI);
  const dLon = milesToLonDegrees(CONFIG.MAP_RADIUS_MI, trackingLocation.lat);
  map.fitBounds([
    [trackingLocation.lat - dLat, trackingLocation.lon - dLon],
    [trackingLocation.lat + dLat, trackingLocation.lon + dLon],
  ]);

  if (homeMarker) homeMarker.remove();
  homeMarker = L.marker([trackingLocation.lat, trackingLocation.lon], {
    icon: L.divIcon({ className: '', html: '<div class="map-home-dot"></div>', iconSize: [10, 10] }),
  }).addTo(map);

  if (radiusCircle) radiusCircle.remove();
  radiusCircle = L.circle([trackingLocation.lat, trackingLocation.lon], {
    radius: CONFIG.MAP_RADIUS_MI * 1609.34, // miles -> meters
    color: '#2E2E2E',
    weight: 1,
    fill: false,
  }).addTo(map);

  // Container size can change (e.g. settings panel affecting layout); fitBounds
  // needs an accurate size to compute zoom correctly.
  setTimeout(() => map.invalidateSize(), 50);
}

function updateMapFlights(rows) {
  if (!map) return;
  const seen = new Set();
  for (const row of rows) {
    if (row.lat == null || row.lon == null) continue;
    seen.add(row.flight);
    const rotation = row.track != null ? row.track : 0;
    let marker = flightMarkers.get(row.flight);
    if (!marker) {
      const icon = L.divIcon({
        className: 'map-plane-icon',
        html: `<svg viewBox="0 0 24 24"><path d="${PLANE_PATH_D}"/></svg><span class="map-plane-label">${row.flight}</span>`,
        iconSize: [27, 27],
        iconAnchor: [13.5, 13.5],
      });
      marker = L.marker([row.lat, row.lon], { icon }).addTo(map);
      flightMarkers.set(row.flight, marker);
    } else {
      marker.setLatLng([row.lat, row.lon]);
    }
    const el = marker.getElement();
    if (el) {
      const svg = el.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${rotation}deg)`;
    }
  }
  // Drop markers for flights no longer on the board.
  for (const [flight, marker] of flightMarkers) {
    if (!seen.has(flight)) {
      marker.remove();
      flightMarkers.delete(flight);
    }
  }
}

// ---------------- App bootstrap ----------------

function main() {
  const rowsContainer = document.getElementById('rows');
  const emptyState = document.getElementById('empty-state');
  const reconnectBadge = document.getElementById('reconnect-badge');
  const clockEl = document.getElementById('clock');
  const splash = document.getElementById('splash');
  const tapStart = document.getElementById('tap-start');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const intervalOptions = document.getElementById('interval-options');
  const muteToggle = document.getElementById('mute-toggle');
  const mapToggle = document.getElementById('map-toggle');
  const mapSection = document.getElementById('map-section');
  const rowsMinus = document.getElementById('rows-minus');
  const rowsPlus = document.getElementById('rows-plus');
  const rowsCountLabel = document.getElementById('rows-count');
  const radiusMinus = document.getElementById('radius-minus');
  const radiusPlus = document.getElementById('radius-plus');
  const radiusCountLabel = document.getElementById('radius-count');
  const zipInput = document.getElementById('zip-input');
  const zipSet = document.getElementById('zip-set');
  const zipStatus = document.getElementById('zip-status');
  const eyebrowLocation = document.getElementById('eyebrow-location');
  const fullscreenToggle = document.getElementById('fullscreen-toggle');
  const pageEl = document.getElementById('page');
  const boardContent = document.getElementById('board-content');
  const singleContent = document.getElementById('single-content');
  const viewModeOptions = document.getElementById('view-mode-options');
  const singleViewRefs = {
    flight: document.getElementById('single-flight'),
    route: document.getElementById('single-route'),
    type: document.getElementById('single-type'),
    telemetry: document.getElementById('single-telemetry'),
    dest: document.getElementById('single-departing-dest'),
    logoCanvas: document.getElementById('single-logo-canvas'),
  };

  initClock(clockEl);
  initMap();

  const clack = new ClackPlayer();
  // Pre-build the max possible rows; unused ones stay hidden rather than being
  // created/destroyed each time the row count setting changes.
  const boardRows = Array.from({ length: CONFIG.MAX_ROWS }, () => new BoardRow(rowsContainer));

  let lastGoodRows = null;
  let backoffMs = CONFIG.BACKOFF_START_MS;
  let pollTimer = null;
  let inBackoff = false;
  let flipIntervalMs = loadFlipInterval();
  let rowCount = loadRowCount();
  // Settings changes (zip, radius, row count) all call poll() immediately rather
  // than waiting out the flip interval. Without this guard, clicking a stepper
  // rapidly starts overlapping in-flight poll() calls — each one eventually
  // resolves and schedules its OWN setTimeout(poll, ...), so the polling loop
  // silently multiplies and starts hammering adsb.lol well past its courtesy
  // floor. Every poll() tags itself with the current generation on entry; if a
  // newer call started (and bumped the generation) before this one's awaits
  // resolve, this one is stale and must not render or schedule a follow-up.
  let pollGeneration = 0;

  function applyRowCount() {
    boardRows.forEach((row, i) => {
      row.el.hidden = i >= rowCount;
      row.el.classList.toggle('is-last', i === rowCount - 1);
    });
    rowsCountLabel.textContent = String(rowCount);
    rowsMinus.disabled = rowCount <= CONFIG.MIN_ROWS;
    rowsPlus.disabled = rowCount >= CONFIG.MAX_ROWS;
    // The board is sized to its content, so a row-count change moves the map's
    // scroll position and can change its container's aspect ratio. invalidateSize()
    // alone only repositions tiles at the CURRENT zoom — if the container's size
    // was wrong when the zoom was last computed (e.g. right after page load,
    // before layout settles), that wrong zoom persists and tiles render at the
    // wrong scale. recenterMap() re-runs fitBounds too, so zoom is always
    // recalculated fresh for whatever size the container actually is now.
    if (map) setTimeout(() => recenterMap(), 60);
  }
  applyRowCount();

  function render(rows) {
    emptyState.hidden = rows.length > 0;
    for (let i = 0; i < rowCount; i++) {
      boardRows[i].setData(rows[i] || null, () => clack.clack());
    }
    updateMapFlights(rows);
    updateSingleView(singleViewRefs, rows[0] || null);
  }

  async function poll() {
    const myGeneration = ++pollGeneration;
    try {
      const positions = await fetchPositions();
      const candidates = filterAndSort(positions);
      const rows = await buildBoard(candidates, rowCount);
      if (myGeneration !== pollGeneration) return; // superseded — don't render or reschedule
      lastGoodRows = rows;
      reconnectBadge.hidden = true;
      backoffMs = CONFIG.BACKOFF_START_MS;
      inBackoff = false;
      render(rows);
      pollTimer = setTimeout(poll, flipIntervalMs);
    } catch (err) {
      if (myGeneration !== pollGeneration) return; // superseded — don't reschedule
      // Keep showing the last known board; surface only the small reconnect indicator.
      reconnectBadge.hidden = false;
      inBackoff = true;
      if (lastGoodRows) render(lastGoodRows);
      pollTimer = setTimeout(poll, backoffMs);
      backoffMs = Math.min(backoffMs * 2, CONFIG.BACKOFF_MAX_MS);
    }
  }

  // ---- Settings: flip interval + mute ----

  function paintIntervalButtons() {
    intervalOptions.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.interval) === flipIntervalMs);
    });
  }

  function paintMuteButton() {
    muteToggle.textContent = clack.muted ? 'OFF' : 'ON';
    muteToggle.classList.toggle('active', !clack.muted);
  }

  clack.setMuted(loadMuted());
  paintIntervalButtons();
  paintMuteButton();

  settingsBtn.addEventListener('click', (e) => {
    settingsPanel.hidden = !settingsPanel.hidden;
    e.stopPropagation();
  });

  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target)) {
      settingsPanel.hidden = true;
    }
  });

  intervalOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-interval]');
    if (!btn) return;
    flipIntervalMs = Number(btn.dataset.interval);
    localStorage.setItem(STORAGE_KEYS.flipInterval, String(flipIntervalMs));
    paintIntervalButtons();
    // Apply immediately, but never interrupt an active reconnect backoff cycle.
    if (!inBackoff && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, flipIntervalMs);
    }
  });

  muteToggle.addEventListener('click', () => {
    clack.setMuted(!clack.muted);
    localStorage.setItem(STORAGE_KEYS.muted, String(clack.muted));
    paintMuteButton();
  });

  // ---- Settings: map on/off (collapsible — reached by scrolling below the
  // always-full-screen board, never squeezed into it). The on/off preference is
  // tracked separately per view mode: BOARD still defaults ON (unchanged), SINGLE
  // defaults OFF (it's meant to fill the screen on its own, kiosk-style) — each
  // remembers its own last choice independently once the user touches the toggle. ----

  function mapStorageKeyFor(mode) {
    return mode === 'single' ? STORAGE_KEYS.mapEnabledSingle : STORAGE_KEYS.mapEnabled;
  }

  function loadMapEnabledFor(mode) {
    const stored = localStorage.getItem(mapStorageKeyFor(mode));
    if (stored !== null) return stored === 'true';
    return mode !== 'single'; // board: default on; single: default off
  }

  function paintMapToggle(enabled) {
    mapToggle.textContent = enabled ? 'ON' : 'OFF';
    mapToggle.classList.toggle('active', enabled);
  }

  function setMapEnabled(enabled) {
    localStorage.setItem(mapStorageKeyFor(displayMode), String(enabled));
    paintMapToggle(enabled);
    mapSection.hidden = !enabled;
    // Leaflet can't measure a display:none container — recompute (size AND zoom,
    // see the comment in applyRowCount) once it's visible again.
    if (enabled && map) setTimeout(() => recenterMap(), 60);
  }

  mapToggle.addEventListener('click', () => setMapEnabled(mapSection.hidden));

  // ---- Settings: view mode (BOARD split-flap list vs SINGLE flight departure-sign
  // card) — both render off the same poll loop/data, this just toggles which
  // content element inside .board is visible. Switching modes also restores that
  // mode's own map on/off preference (see above) and, for SINGLE, stretches the
  // board chassis to fill the screen (see .page.mode-single in style.css). ----

  let displayMode = loadDisplayMode();

  function applyDisplayMode() {
    boardContent.hidden = displayMode !== 'board';
    singleContent.hidden = displayMode !== 'single';
    pageEl.classList.toggle('mode-single', displayMode === 'single');
    viewModeOptions.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === displayMode);
    });
    setMapEnabled(loadMapEnabledFor(displayMode));
  }
  applyDisplayMode();

  viewModeOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    displayMode = btn.dataset.mode;
    localStorage.setItem(STORAGE_KEYS.displayMode, displayMode);
    applyDisplayMode();
  });

  // ---- Display: fullscreen (hides Safari's URL bar/toolbar chrome) ----
  //
  // Safari on iPad added support for the standard Fullscreen API on ordinary
  // elements (not just <video>) in relatively recent iPadOS releases; older
  // iPads won't have it. Feature-detect and hide the control entirely rather
  // than showing a button that silently does nothing. "Add to Home Screen"
  // (see manifest.json) remains the more reliable chrome-less option on iOS
  // regardless of Fullscreen API support.

  const fsRequest =
    document.documentElement.requestFullscreen ||
    document.documentElement.webkitRequestFullscreen;
  const fsExit = document.exitFullscreen || document.webkitExitFullscreen;
  const fsSupported = !!(fsRequest && fsExit);

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function paintFullscreenButton() {
    fullscreenToggle.textContent = isFullscreen() ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
  }

  if (fsSupported) {
    fullscreenToggle.addEventListener('click', () => {
      if (isFullscreen()) {
        fsExit.call(document);
      } else {
        // The standard API returns a Promise; the older webkit-prefixed one
        // (still relevant on some iPadOS versions) doesn't.
        const result = fsRequest.call(document.documentElement);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {
            // Some browsers reject requestFullscreen outside a "trusted" user
            // gesture context in edge cases — nothing more to do about it here.
          });
        }
      }
    });
    document.addEventListener('fullscreenchange', paintFullscreenButton);
    document.addEventListener('webkitfullscreenchange', paintFullscreenButton);
    paintFullscreenButton();
  } else {
    fullscreenToggle.disabled = true;
    fullscreenToggle.textContent = 'UNSUPPORTED';
  }

  function setRowCount(next) {
    rowCount = Math.max(CONFIG.MIN_ROWS, Math.min(CONFIG.MAX_ROWS, next));
    localStorage.setItem(STORAGE_KEYS.rowCount, String(rowCount));
    applyRowCount();
    // A different row count needs a fresh candidate list resolved to match —
    // re-poll now rather than waiting out the current flip interval, unless
    // we're mid-backoff (don't fight the reconnect cycle).
    if (!inBackoff) {
      if (pollTimer) clearTimeout(pollTimer);
      poll();
    }
  }

  rowsMinus.addEventListener('click', () => setRowCount(rowCount - 1));
  rowsPlus.addEventListener('click', () => setRowCount(rowCount + 1));

  function applyRadius() {
    radiusCountLabel.textContent = String(searchRadiusMi);
    radiusMinus.disabled = searchRadiusMi <= CONFIG.MIN_RADIUS_MI;
    radiusPlus.disabled = searchRadiusMi >= CONFIG.MAX_RADIUS_MI;
  }

  function setRadius(next) {
    searchRadiusMi = Math.max(CONFIG.MIN_RADIUS_MI, Math.min(CONFIG.MAX_RADIUS_MI, next));
    localStorage.setItem(STORAGE_KEYS.radiusMi, String(searchRadiusMi));
    applyRadius();
    // A different search radius needs a fresh candidate list — re-poll now, same
    // reasoning as a row-count change.
    if (!inBackoff) {
      if (pollTimer) clearTimeout(pollTimer);
      poll();
    }
  }

  searchRadiusMi = loadRadiusMi();
  applyRadius();
  radiusMinus.addEventListener('click', () => setRadius(searchRadiusMi - CONFIG.RADIUS_STEP_MI));
  radiusPlus.addEventListener('click', () => setRadius(searchRadiusMi + CONFIG.RADIUS_STEP_MI));

  // ---- Settings: tracking location (ZIP) ----

  async function applyZip(zip, persist) {
    try {
      const geo = await geocodeZip(zip);
      trackingLocation.lat = geo.lat;
      trackingLocation.lon = geo.lon;
      eyebrowLocation.textContent = geo.label;
      if (persist) localStorage.setItem(STORAGE_KEYS.zip, zip);
      recenterMap();
      zipStatus.textContent = `LOCATED: ${geo.label}`;
      zipStatus.className = 'settings-status is-ok';
      return true;
    } catch {
      zipStatus.textContent = 'ZIP NOT FOUND';
      zipStatus.className = 'settings-status is-error';
      return false;
    }
  }

  async function handleZipSubmit() {
    const zip = zipInput.value.trim();
    if (!/^\d{5}$/.test(zip)) {
      zipStatus.textContent = 'ENTER A 5-DIGIT US ZIP';
      zipStatus.className = 'settings-status is-error';
      return;
    }
    const ok = await applyZip(zip, true);
    // A relocated board needs a fresh candidate list — re-poll now, same as a
    // row-count change, unless we're mid-backoff.
    if (ok && !inBackoff) {
      if (pollTimer) clearTimeout(pollTimer);
      poll();
    }
  }

  zipSet.addEventListener('click', handleZipSubmit);
  zipInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleZipSubmit();
  });

  const initialZip = loadZip();
  zipInput.value = initialZip;

  tapStart.addEventListener('click', () => {
    clack.unlock();
    splash.hidden = true;
    document.getElementById('board').removeAttribute('aria-hidden');
    poll();
  }, { once: true });

  // Load in the background — the first poll's ETA column just falls back to
  // "--:--" for the brief window before this resolves. Same for the initial
  // ZIP geocode: the board starts at the Edgewater default and updates once
  // (or if) it resolves, rather than blocking the splash on a network call.
  loadAirportCoords();
  applyZip(initialZip, false);
}

document.addEventListener('DOMContentLoaded', main);
