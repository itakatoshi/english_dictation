const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib.js');

test('alignWords: exact match ignores case and punctuation', () => {
  const r = L.alignWords("Now, when a normal student writes a paper.", 'now when a Normal student writes a paper');
  assert.equal(r.correct, true);
  assert.equal(r.accuracy, 1);
});

test('alignWords: one missing word does not cascade into later words', () => {
  const r = L.alignWords('I had to write a lot of papers', 'I had to write lot of papers');
  assert.equal(r.correct, false);
  assert.deepEqual(r.ops.map(op => op.type), ['ok', 'ok', 'ok', 'ok', 'miss', 'ok', 'ok', 'ok']);
});

test('alignWords: extra word is marked, rest stays correct', () => {
  const r = L.alignWords('things stay civil', 'things they stay civil');
  assert.deepEqual(r.ops.map(op => op.type), ['ok', 'extra', 'ok', 'ok']);
});

test('alignWords: spelling slip is a close substitution', () => {
  const r = L.alignWords('government major', 'goverment major');
  assert.equal(r.ops[0].type, 'sub');
  assert.equal(r.ops[0].close, true);
});

test('alignWords: accepts equivalent spellings and numbers', () => {
  assert.equal(L.alignWords('I have 3 well-known colours', 'i have three well known colors').correct, true);
  assert.equal(L.alignWords("I'm gonna go", "I’m going to go").correct, true);
  assert.equal(L.alignWords('OK, fine', 'okay fine').correct, true);
});

test('alignWords: empty input scores 0', () => {
  const r = L.alignWords('hello there world', '');
  assert.equal(r.accuracy, 0);
  assert.equal(r.correct, false);
});

test('cleanUnitText strips speaker marks, sound tags and music symbols', () => {
  assert.equal(L.cleanUnitText('>> [Music] ♪ Never gonna give you up ♪'), 'Never gonna give you up');
  assert.equal(L.cleanUnitText('it&#39;s fine , really'), "it's fine, really");
});

test('captionJsonToCues clips overlapping auto-caption cues', () => {
  const cues = L.captionJsonToCues({
    events: [
      { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'so in college' }] },
      { tStartMs: 2500, dDurationMs: 4000, segs: [{ utf8: 'I was a government major' }] },
      { tStartMs: 3000, dDurationMs: 10, segs: [{ utf8: '\n' }] }
    ]
  });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].end, 2.5);
});

test('cuesToUnits merges to sentence end and splits on gaps', () => {
  const cues = [
    { text: 'So in college,', start: 0, end: 1 },
    { text: 'I was a government major.', start: 1, end: 3 },
    { text: 'Which means I wrote', start: 5, end: 6 },
    { text: 'a lot of papers', start: 6, end: 7 }
  ];
  const units = L.cuesToUnits(cues);
  assert.deepEqual(units.map(u => u.text), ['So in college, I was a government major.', 'Which means I wrote a lot of papers']);
  assert.equal(units[0].start, 0);
  assert.equal(units[0].end, 3);
});

test('cuesToUnits perCue keeps unpunctuated lyric lines separate', () => {
  const cues = [
    { text: 'You know the rules and so do I', start: 0, end: 4 },
    { text: "A full commitment's what I'm thinking of", start: 4.1, end: 8 }
  ];
  assert.equal(L.cuesToUnits(cues).length, 1);
  assert.equal(L.cuesToUnits(cues, { perCue: true, maxSeconds: 4.5, maxWords: 10 }).length, 2);
});

test('pickCaptionTrack prefers manual English over auto-generated', () => {
  const picked = L.pickCaptionTrack([
    { languageCode: 'ja', baseUrl: 'ja' },
    { languageCode: 'en', kind: 'asr', baseUrl: 'asr' },
    { languageCode: 'en', baseUrl: 'manual', name: { simpleText: 'English' } }
  ]);
  assert.equal(picked.track.baseUrl, 'manual');
  assert.equal(L.pickCaptionTrack([{ languageCode: 'ja' }]), null);
});
