// Live check of the caption path content.js uses: innertube player -> json3 -> practice units.
// Usage: node tools/check-captions.mjs [videoId ...]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../lib.js');

const CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 },
  { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2' }
];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['arj7oStGLkU', 'dQw4w9WgXcQ'];
let failed = 0;

for (const videoId of ids) {
  let ok = false;
  for (const client of CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: { ...client, hl: 'en' } }, videoId })
      });
      const tracks = (await res.json())?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const picked = L.pickCaptionTrack(tracks);
      if (!picked) { console.log(`${videoId} ${client.clientName}: no English track (${tracks.length} tracks)`); continue; }
      const url = new URL(picked.track.baseUrl);
      url.searchParams.set('fmt', 'json3');
      const body = await (await fetch(url)).text();
      if (!body.trim()) { console.log(`${videoId} ${client.clientName}: empty caption body`); continue; }
      const cues = L.captionJsonToCues(JSON.parse(body));
      const units = L.cuesToUnits(cues);
      console.log(`${videoId} ${client.clientName}: ${picked.name}${picked.track.kind === 'asr' ? ' (asr)' : ''} cues=${cues.length} units=${units.length}`);
      units.slice(0, 3).forEach(u => console.log(`   ${u.start.toFixed(2)}-${u.end.toFixed(2)}  ${u.text}`));
      ok = units.length > 0;
      break;
    } catch (error) {
      console.log(`${videoId} ${client.clientName}: ${error.message}`);
    }
  }
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
