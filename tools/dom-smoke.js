// End-to-end check of content.js in jsdom with stubbed chrome/video/fetch. Needs: npm install

const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert/strict');
const R = require('path').join(__dirname, '..') + '/';
const dom = new JSDOM(`<!doctype html><html><body><div id="secondary"><div id="secondary-inner"></div></div><video class="html5-main-video"></video></body></html>`,
  { url: 'https://www.youtube.com/watch?v=TEST', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const store = { sync: { enabled: true, mode: 'full' }, local: {} };
const listeners = [];
w.chrome = { storage: {
  sync: { get: (d, cb) => cb({ ...d, ...store.sync }), set: (o) => { Object.assign(store.sync, o); listeners.forEach(l => l(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: v }])), 'sync')); } },
  local: { get: (d, cb) => cb({ ...d, ...store.local }), set: (o) => Object.assign(store.local, o) },
  onChanged: { addListener: (l) => listeners.push(l) } } };
// video stub
const video = w.document.querySelector('video');
let t = 0, paused = true;
Object.defineProperty(video, 'currentTime', { get: () => t, set: (v) => { t = v; video.dispatchEvent(new w.Event('seeked')); } });
Object.defineProperty(video, 'paused', { get: () => paused });
video.play = async () => { paused = false; };
video.pause = () => { paused = true; };
Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.parentNode; } });
Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; } });
w.document.execCommand = () => true;
// fetch stub: innertube -> tracks, timedtext -> json3
w.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('/youtubei/v1/player')) return { ok: true, json: async () => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=TEST', name: { simpleText: 'English' } }] } } }) };
  if (url.includes('timedtext')) return { ok: true, text: async () => JSON.stringify({ events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'I had to write a lot of papers.' }] },
    { tStartMs: 3500, dDurationMs: 2000, segs: [{ utf8: 'Things stay really civil here.' }] }] }) };
  throw new Error('unexpected fetch ' + url);
};
w.eval(fs.readFileSync(R + 'lib.js', 'utf8'));
w.eval(fs.readFileSync(R + 'content.js', 'utf8'));
const $ = (s) => w.document.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(50);
  console.log('sync:', $('.ydt-sync').textContent, '| hidden:', $('#ydt-shell').hidden, '| parent:', $('#ydt-shell').parentElement.id);
  await video.play(); t = 2.99; video.dispatchEvent(new w.Event('timeupdate'));
  assert.equal(paused, true, 'video pauses at end of unit');
  assert.equal($('.ydt-question-no').textContent, '1 / 2');
  console.log('paused at end:', paused, '| q:', $('.ydt-question-no').textContent, '| guide words:', $('.ydt-full-guide').children.length);
  $('.ydt-answer-box').textContent = 'I had to write lot of paper';
  $('.ydt-check').click();
  console.log('feedback:', $('.ydt-feedback').textContent);
  console.log('box:', $('.ydt-answer-box').textContent, '| reveal:', $('.ydt-reveal').textContent);
  assert.match($('.ydt-feedback').textContent, /正答率 75%/);
  assert.equal(store.local.ydtMistakes.length, 1);
  console.log('stats:', $('.ydt-stats').textContent, '| mistakes:', store.local.ydtMistakes?.length, store.local.ydtHistory);
  $('.ydt-check').click(); // next
  assert.equal(paused, false, 'next resumes playback');
  console.log('after next paused:', paused, '| idle:', $('.ydt-idle').textContent);
  // switch to blanks mode, reach next unit
  w.chrome.storage.sync.set({ mode: 'blanks', blankCount: 2 });
  t = 5.49; video.dispatchEvent(new w.Event('timeupdate'));
  console.log('blank q:', $('.ydt-blank-question').textContent, '| inputs:', w.document.querySelectorAll('.ydt-answer').length, [...w.document.querySelectorAll('.ydt-answer')].map(i => i.placeholder));
  $('.ydt-hint').click();
  console.log('after hint:', [...w.document.querySelectorAll('.ydt-answer')].map(i => i.value));
  $('.ydt-pass').click();
  assert.equal(w.document.querySelectorAll('.ydt-answer').length, 2);
  assert.match($('.ydt-reveal').textContent, /Things stay really civil here/);
  console.log('reveal:', $('.ydt-reveal').textContent, '| slots:', [...w.document.querySelectorAll('.ydt-blank-slot')].map(s => s.textContent + ':' + s.className));
  $('.ydt-prev').click();
  console.log('prev -> t:', t.toFixed(2), 'paused:', paused);
  // replay
  t = 2.99; video.dispatchEvent(new w.Event('timeupdate'));
  $('.ydt-listen').click(); console.log('replay t:', t.toFixed(2), 'rate:', video.playbackRate);
  t = 3.2; video.dispatchEvent(new w.Event('timeupdate')); assert.equal(paused, true, 'replay stops at unit end'); console.log('replay stopped:', paused, 'rate restored:', video.playbackRate);
  // navigating to home hides panel
  dom.reconfigure({ url: 'https://www.youtube.com/' }); await sleep(1100);
  assert.equal($('#ydt-shell').hidden, true, 'panel hidden off watch pages');
  console.log('DOM smoke test: OK');
  console.log('home hidden:', $('#ydt-shell').hidden);
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
