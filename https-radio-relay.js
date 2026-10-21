/**
 * https-radio-relay.js
 *
 * A tiny relay that re-serves plain http:// radio streams over https://
 * so they can be played from a page loaded over HTTPS (browsers block
 * mixed-content audio otherwise).
 *
 * WHY YOU NEED THIS:
 * Shoutcast/Icecast servers almost never support TLS themselves. This
 * relay sits in front of them: your browser talks HTTPS to this relay,
 * the relay talks plain HTTP to the station, and pipes the audio straight
 * through, chunk by chunk, with no buffering — so it works for
 * continuous live streams, not just short clips.
 *
 * HOW TO RUN LOCALLY:
 *   npm install express node-fetch@2
 *   node https-radio-relay.js
 *   -> relay listens on http://localhost:8787
 *      (deploy it — see below — to get a real https:// URL)
 *
 * USAGE:
 *   https://your-deployed-relay.com/relay?url=http://sonic.radiostream.ca/8034/stream
 *
 * DEPLOYING FOR FREE (so you get a real https:// address):
 *   - Render.com, Railway.app, Fly.io, or Glitch.com all offer free tiers
 *     that give you HTTPS automatically. Push this file (plus a
 *     package.json with "express" and "node-fetch": "^2" as dependencies)
 *     and it just works — no config needed beyond the PORT env var,
 *     which these platforms set automatically.
 *
 * Then in the tuner artifact, replace a station's http:// url with:
 *   https://your-deployed-relay.com/relay?url=<the original http url, URL-encoded>
 */

const express = require('express');
const fetch = require('node-fetch');
const icy = require('icy');
const http = require('http');
const https = require('https');

// Tunables for the /relay resilience logic
const STALL_MS = 10000;              // no audio from the station for this long = connection is dead
const MAX_RECONNECTS = 20;           // consecutive failed reconnects before giving up on a live session
const HEALTHY_CONNECTION_MS = 15000; // a connection that lasted this long resets the failure count
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const app = express();
const PORT = process.env.PORT || 8787;

// Optional: lock the relay down to only your own known stream hosts,
// so it can't be used as an open proxy for arbitrary URLs.
const ALLOWED_HOSTS = [
  'sonic.radiostream.ca',
  'ais-sa3.cdnstream1.com',
  'sc6.radiocaroline.net',
  'stream.radiocaroline.net',
  '78.129.202.10',
  's1.viastreaming.net',
  'stream.tripleafm.com.au',
  'stream.mjm-webhosting.com.au',
  'cast.fabrik.fm',
  's6.myradiostream.com',
  'uk21freenew.listen2myradio.com',
  'streaming.edmradio.online',
  '144.139.171.204',
  'stream0.wfmu.org',
  'streaming.live365.com',
  'cast6.asurahosting.com',
  'das-edge11-live365-dal03.cdnstream.com',
  's1.communitybroadcastnetwork.com.au',
  '13.54.221.214',
  '104.128.238.80',
  's10.myradiostream.com',
  's15.myradiostream.com',
  'stream.swifthosting.com.au',
  'listen.southcoastfm.au',
  'live.yarravalleyfm.org.au',
  'streaming1.coastfm.com.au',
  'stream.hfm.radio',
];

// CORS preflight: the tuner's "now playing" reader fetch()es the relay with a
// custom Icy-MetaData header, which makes the browser send an OPTIONS
// preflight first. Without this, Chrome reports "CORS request blocked
// because of invalid or missing response headers" for relayed stations.
app.options('/relay', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Icy-MetaData, Range, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

app.get('/relay', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send('Missing ?url= parameter');
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).send('Invalid url parameter');
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    console.log('Rejected host:', JSON.stringify(parsed.hostname), '| full target:', target);
    return res.status(403).send('Host not allow-listed. Add it to ALLOWED_HOSTS in the relay script.');
  }

  // Only ask upstream for in-stream ICY metadata when the caller did (the
  // tuner's now-playing reader). Plain <audio> playback never sends this
  // header, so it keeps getting clean audio with no metadata blocks mixed in.
  const wantsMeta = req.get('Icy-MetaData') === '1';
  const upstreamHeaders = { 'User-Agent': 'https-radio-relay/1.0' };
  if (wantsMeta) upstreamHeaders['Icy-MetaData'] = '1';
  const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

  try { req.socket.setNoDelay(true); req.socket.setKeepAlive(true, 30000); } catch {}

  // --- resilient pipe ---------------------------------------------------
  // The browser's connection to this relay stays open for the whole
  // listening session. If the connection to the radio station drops, stalls
  // or ends, we quietly reconnect to the station and carry on feeding the
  // same response, so the listener never has to restart playback.
  // (Not done for metadata requests: a reconnect would break the byte
  // alignment of the in-stream metadata blocks.)
  let clientGone = false;
  let started = false;        // has any audio been written to the browser yet?
  let headersSet = false;
  let failures = 0;           // consecutive failed or short-lived connections
  let reconnectTimer = null;
  let activeAbort = null;
  let activeBody = null;

  res.on('close', () => {
    clientGone = true;
    clearTimeout(reconnectTimer);
    try { activeAbort && activeAbort.abort(); } catch {}
    try { activeBody && activeBody.destroy(); } catch {}
  });

  function giveUp(message) {
    if (!started && !res.headersSent) res.status(502).send(message);
    else res.end();
  }

  function scheduleReconnect(reason, connectedForMs) {
    if (clientGone) return;
    if (connectedForMs > HEALTHY_CONNECTION_MS) failures = 0;
    failures++;
    console.log('Upstream', reason, '| attempt', failures, '|', target);
    const maxFailures = started ? MAX_RECONNECTS : 2;
    if ((wantsMeta && started) || failures > maxFailures) {
      return giveUp('Upstream stream unavailable (' + reason + ')');
    }
    const delay = Math.min(500 * failures, 4000);
    reconnectTimer = setTimeout(connect, delay);
  }

  async function connect() {
    if (clientGone) return;
    const abort = new AbortController();
    activeAbort = abort;
    const connectedAt = Date.now();

    let upstream;
    try {
      upstream = await fetch(target, { headers: upstreamHeaders, agent, signal: abort.signal });
    } catch (err) {
      return scheduleReconnect('connect error: ' + err.message, 0);
    }
    if (clientGone) { try { upstream.body && upstream.body.destroy(); } catch {} return; }

    if (!upstream.ok || !upstream.body) {
      try { upstream.body && upstream.body.destroy(); } catch {}
      // A definitive refusal on the very first connect (403, 404 ...) isn't worth retrying.
      if (!started && upstream.status >= 400 && upstream.status < 500) {
        console.log('Upstream not ok:', upstream.status, upstream.statusText, '|', target);
        return giveUp('Upstream stream unavailable (upstream status ' + upstream.status + ' ' + upstream.statusText + ')');
      }
      return scheduleReconnect('status ' + upstream.status, 0);
    }

    if (!headersSet) {
      headersSet = true;
      // Forward the content type (e.g. audio/mpeg, audio/aac) so the
      // browser's <audio> element knows how to decode it.
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'icy-metaint, icy-name');
      const metaint = upstream.headers.get('icy-metaint');
      if (metaint && wantsMeta) res.setHeader('icy-metaint', metaint);
      const icyName = upstream.headers.get('icy-name');
      if (icyName) res.setHeader('icy-name', icyName);
    }

    const body = upstream.body;
    activeBody = body;
    let finished = false;
    let stallTimer = null;
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(stallTimer);
      try { abort.abort(); } catch {}
      try { body.destroy(); } catch {}
      scheduleReconnect(reason, Date.now() - connectedAt);
    };
    // No audio for a while = the connection has silently died.
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish('stalled (no data for ' + STALL_MS / 1000 + 's)'), STALL_MS);
    };
    armStall();

    body.on('data', chunk => {
      if (clientGone || finished) return;
      started = true;
      armStall();
      if (!res.write(chunk)) {
        // Browser is slow: pause the station feed until it catches up.
        body.pause();
        clearTimeout(stallTimer);
        res.once('drain', () => { if (!finished) { body.resume(); armStall(); } });
      }
    });
    body.on('end', () => finish('ended'));
    body.on('error', err => finish('error: ' + err.message));
  }

  connect();
});

// ---------------------------------------------------------------------
// /meta?url=<original station stream url>
//
// Best-effort "now playing" lookup. Tries, in order:
//   1. StreamTheWorld / Triton Digital's public nowplaying API
//   2. Icecast's status-json.xsl
//   3. Shoutcast v2's stats?json=1
//   4. Shoutcast v1's 7.html
// Returns { title: "Artist - Track" } or { title: null } if nothing
// could be found (unsupported server, metadata turned off, etc).
// This endpoint is intentionally NOT restricted by ALLOWED_HOSTS — it's
// read-only, returns no audio, and only ever hits a host the tuner
// already told it to look up.
// ---------------------------------------------------------------------

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function deriveStreamTheWorldMount(target) {
  const u = new URL(target);
  if (!/streamtheworld\.com$|ihrhls\.com$/.test(u.hostname)) return null;
  const lastSegment = u.pathname.split('/').filter(Boolean).pop() || '';
  const mount = lastSegment
    .replace(/\.(aac|mp3|m3u8)$/i, '')
    .replace(/_(PREM|SC|ICECAST)$/i, '');
  return mount || null;
}

// StreamTheWorld's own nowplaying API (not Triton's np.tritondigital.com,
// which uses a different "mountName" that doesn't always match the
// stream URL's slug).
async function tryStreamTheWorldNative(mount) {
  const t = withTimeout(4000);
  try {
    const r = await fetch(
      `https://playerservices.streamtheworld.com/api/nowplaying?mount=${encodeURIComponent(mount)}&format=json`,
      { signal: t.signal }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const item = Array.isArray(data?.item) ? data.item[0] : (data?.item || data);
    const title = item && (item.cue_title || item.track || item.title);
    const artist = item && (item.cue_artist || item.artist);
    if (!title) return null;
    return artist ? `${artist} - ${title}` : title;
  } catch {
    return null;
  } finally {
    t.cancel();
  }
}

// Fallback: Triton Digital's public nowplaying API, in case the mount
// name happens to match there instead.
async function tryTritonNowplaying(mount) {
  const t = withTimeout(4000);
  try {
    const r = await fetch(
      `https://np.tritondigital.com/public/nowplaying?mountName=${encodeURIComponent(mount)}&numberToFetch=1`,
      { signal: t.signal }
    );
    if (!r.ok) return null;
    const xml = await r.text();
    const artist = /<property name="cue_artist">([^<]*)<\/property>/i.exec(xml);
    const title = /<property name="cue_title">([^<]*)<\/property>/i.exec(xml);
    if (title && title[1]) {
      return artist && artist[1] ? `${artist[1]} - ${title[1]}` : title[1];
    }
    return null;
  } catch {
    return null;
  } finally {
    t.cancel();
  }
}

async function tryStreamTheWorld(target) {
  const mount = deriveStreamTheWorldMount(target);
  if (!mount) return null;
  return (await tryStreamTheWorldNative(mount)) || (await tryTritonNowplaying(mount));
}

async function tryIcecastStatus(origin) {
  const t = withTimeout(4000);
  try {
    const r = await fetch(`${origin}/status-json.xsl`, { signal: t.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const sources = data && data.icestats ? data.icestats.source : null;
    if (!sources) return null;
    const list = Array.isArray(sources) ? sources : [sources];
    const withTitle = list.find(s => s && s.title);
    return withTitle ? withTitle.title : null;
  } catch {
    return null;
  } finally {
    t.cancel();
  }
}

async function tryShoutcastV2(origin) {
  const t = withTimeout(4000);
  try {
    const r = await fetch(`${origin}/stats?json=1`, { signal: t.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const title = data.songtitle || data.SONGTITLE || data.servertitle || null;
    return title || null;
  } catch {
    return null;
  } finally {
    t.cancel();
  }
}

async function tryShoutcastV1(origin) {
  const t = withTimeout(4000);
  try {
    const r = await fetch(`${origin}/7.html`, { signal: t.signal });
    if (!r.ok) return null;
    const text = await r.text();
    const parts = text.replace(/<[^>]+>/g, '').split(',');
    const title = parts.length >= 6 ? parts.slice(6).join(',').trim() : parts[parts.length - 1].trim();
    return title || null;
  } catch {
    return null;
  } finally {
    t.cancel();
  }
}

// Generic catch-all: reads the "StreamTitle" that almost every
// Shoutcast/Icecast server embeds directly in the audio stream itself
// (the ICY metadata protocol), regardless of whether that server also
// exposes a separate /stats or /status-json.xsl page. This is the most
// broadly compatible method, but it means briefly opening the actual
// audio stream, so it's heavier than the JSON-based checks above and
// only makes sense as a fallback for them, not a replacement.
// Doesn't apply to HLS (.m3u8) or DASH (.mpd) streams, which don't use
// the ICY protocol at all.
function tryIcyMetadata(target) {
  if (/\.(m3u8|mpd)(\?|$)/i.test(target)) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    let req;
    const finish = title => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req && req.destroy(); } catch {}
      resolve(title || null);
    };
    const timer = setTimeout(() => finish(null), 6000);
    try {
      req = icy.get(target, res => {
        res.on('metadata', metadata => {
          const parsed = icy.parse(metadata);
          finish(parsed && parsed.StreamTitle);
        });
        res.on('error', () => finish(null));
        // No 'metadata' event ever fires on a stream with no icy-metaint
        // header (metadata turned off, or not an ICY server at all) —
        // the timeout above catches that case.
      });
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

app.get('/meta', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ title: null });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ title: null });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const origin = `${parsed.protocol}//${parsed.host}`;

  const title =
    (await tryStreamTheWorld(target)) ||
    (await tryIcecastStatus(origin)) ||
    (await tryShoutcastV2(origin)) ||
    (await tryShoutcastV1(origin)) ||
    (await tryIcyMetadata(target)) ||
    null;

  res.json({ title });
});

// Diagnostic twin of /meta: instead of returning the first match, it
// returns what EVERY candidate endpoint actually said, so a failure can
// be diagnosed from the browser without needing shell access to this
// server's logs.
app.get('/meta/debug', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url=' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  const origin = `${parsed.protocol}//${parsed.host}`;
  const mount = deriveStreamTheWorldMount(target);

  async function probe(label, url) {
    const t = withTimeout(5000);
    try {
      const r = await fetch(url, { signal: t.signal });
      const text = await r.text();
      return { label, url, status: r.status, body: text.slice(0, 500) };
    } catch (err) {
      return { label, url, error: err.message };
    } finally {
      t.cancel();
    }
  }

  const probes = [];
  if (mount) {
    probes.push(
      probe('streamtheworld-native', `https://playerservices.streamtheworld.com/api/nowplaying?mount=${encodeURIComponent(mount)}&format=json`),
      probe('triton-nowplaying', `https://np.tritondigital.com/public/nowplaying?mountName=${encodeURIComponent(mount)}&numberToFetch=1`)
    );
  }
  probes.push(
    probe('icecast-status-json', `${origin}/status-json.xsl`),
    probe('shoutcast-v2', `${origin}/stats?json=1`),
    probe('shoutcast-v1', `${origin}/7.html`)
  );

  const [jsonResults, icyTitle] = await Promise.all([
    Promise.all(probes),
    tryIcyMetadata(target),
  ]);

  res.json({
    target,
    derivedMount: mount,
    results: [...jsonResults, { label: 'icy-stream-metadata', result: icyTitle }],
  });
});

app.get('/', (req, res) => {
  res.send('https-radio-relay is running. Use /relay?url=http://..., /meta?url=http://... or /meta/debug?url=http://...');
});

app.listen(PORT, () => {
  console.log(`https-radio-relay listening on port ${PORT}`);
});
