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
  'stream0.wfmu.org',
  'streaming.live365.com',
  'cast6.asurahosting.com',
  'das-edge11-live365-dal03.cdnstream.com',
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

app.get('/', (req, res) => {
  res.send('https-radio-relay is running. Use /relay?url=http://...');
});

app.listen(PORT, () => {
  console.log(`https-radio-relay listening on port ${PORT}`);
});
