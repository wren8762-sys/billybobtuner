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

const app = express();
const PORT = process.env.PORT || 8787;

// Optional: lock the relay down to only your own known stream hosts,
// so it can't be used as an open proxy for arbitrary URLs.
const ALLOWED_HOSTS = [
  'sonic.radiostream.ca',
  'ais-sa3.cdnstream1.com',
  'sc6.radiocaroline.net',
  'stream.radiocaroline.net',
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

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'https-radio-relay/1.0' },
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('Upstream stream unavailable');
    }

    // Forward the content type (e.g. audio/mpeg, audio/aac) so the
    // browser's <audio> element knows how to decode it.
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'audio/mpeg'
    );
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe the live stream straight through, chunk by chunk.
    upstream.body.pipe(res);

    req.on('close', () => {
      upstream.body.destroy();
    });
  } catch (err) {
    console.error('Relay error:', err.message);
    res.status(502).send('Failed to reach upstream stream');
  }
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

async function tryStreamTheWorld(target) {
  const u = new URL(target);
  if (!/streamtheworld\.com$|ihrhls\.com$/.test(u.hostname)) return null;

  // Derive a likely Triton "mount" name from the last path segment,
  // stripping common StreamTheWorld/iHeart suffixes.
  const lastSegment = u.pathname.split('/').filter(Boolean).pop() || '';
  const mount = lastSegment
    .replace(/\.(aac|mp3|m3u8)$/i, '')
    .replace(/_(PREM|SC|ICECAST)$/i, '');
  if (!mount) return null;

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
    null;

  res.json({ title });
});

app.get('/', (req, res) => {
  res.send('https-radio-relay is running. Use /relay?url=http://... or /meta?url=http://...');
});

app.listen(PORT, () => {
  console.log(`https-radio-relay listening on port ${PORT}`);
});
