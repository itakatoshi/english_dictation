// Pure helpers shared by content.js and the Node tests (no DOM / chrome APIs here).
(function (root) {
  const MIN_WORDS = 3;
  const MAX_UNIT_SECONDS = 8.0;
  const MAX_UNIT_WORDS = 20;
  const GAP_SECONDS = 0.75;

  const NUMBER_WORDS = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
    fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
    nineteen: '19', twenty: '20', hundred: '100', thousand: '1000'
  };

  // Common spelling variants that should not count as mistakes.
  const EQUIVALENTS = {
    ok: 'okay', 'o.k': 'okay', gonna: 'going to', wanna: 'want to', gotta: 'got to',
    '&': 'and', mr: 'mister', mrs: 'missus', dr: 'doctor',
    colour: 'color', favourite: 'favorite', centre: 'center', theatre: 'theater',
    realise: 'realize', organise: 'organize', recognise: 'recognize'
  };

  const normalizeSpaces = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const stripOuterPunctuation = (word) => String(word || '').replace(/^[^A-Za-z0-9'’]+|[^A-Za-z0-9'’%]+$/g, '');

  // Lowercase, unify apostrophes, drop punctuation. Hyphens become spaces ("well-known" == "well known").
  function normalizeToken(text) {
    let t = String(text || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'%&]/g, '');
    t = t.replace(/^'+|'+$/g, '');
    if (NUMBER_WORDS[t]) return NUMBER_WORDS[t];
    if (EQUIVALENTS[t] && !EQUIVALENTS[t].includes(' ')) return EQUIVALENTS[t];
    // Inflected British spellings: colours / realised / organising.
    for (const suffix of ['s', 'd', 'ing']) {
      if (!t.endsWith(suffix)) continue;
      const stem = t.slice(0, -suffix.length);
      const base = EQUIVALENTS[stem] || EQUIVALENTS[`${stem}e`];
      if (base && !base.includes(' ')) return (EQUIVALENTS[stem] ? base : base.replace(/e$/, '')) + suffix;
    }
    return t;
  }

  const tokenize = (text) => splitWords(text).map(w => w.token);
  const normalizeSentence = (text) => tokenize(text).join(' ');

  // Like tokenize(), but keeps the original spelling for display.
  // Multi-word equivalents ("gonna") expand to their parts so "going to" can match them.
  function splitWords(text) {
    const out = [];
    for (const raw of normalizeSpaces(String(text || '').replace(/[-–—/]/g, ' ')).split(' ')) {
      const key = String(raw).toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9'&]/g, '');
      if (EQUIVALENTS[key] && EQUIVALENTS[key].includes(' ')) {
        for (const part of EQUIVALENTS[key].split(' ')) out.push({ display: part, token: part });
        continue;
      }
      const token = normalizeToken(raw);
      if (token) out.push({ display: raw, token });
    }
    return out;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  }

  // Word-level alignment between the expected sentence and what the user typed.
  // Returns ops: {type:'ok'|'sub'|'miss'|'extra', expected, actual, close}
  // 'close' marks a substitution that is only a small spelling slip.
  function alignWords(expected, actual) {
    const expWords = splitWords(expected);
    const actWords = splitWords(actual);
    const exp = expWords.map(w => w.display);
    const act = actWords.map(w => w.display);
    const e = expWords.map(w => w.token);
    const a = actWords.map(w => w.token);
    const n = e.length;
    const m = a.length;

    const subCost = (i, j) => {
      if (e[i] === a[j]) return 0;
      // A near-miss spelling is cheaper than delete+insert, so it aligns as a substitution.
      const d = levenshtein(e[i], a[j]);
      return d <= Math.max(1, Math.floor(Math.max(e[i].length, a[j].length) / 3)) ? 1 : 1.9;
    };

    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 0; i <= n; i += 1) dp[i][0] = i;
    for (let j = 0; j <= m; j += 1) dp[0][j] = j;
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        dp[i][j] = Math.min(
          dp[i - 1][j - 1] + subCost(i - 1, j - 1),
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1
        );
      }
    }

    const ops = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + subCost(i - 1, j - 1)) {
        const same = e[i - 1] === a[j - 1];
        ops.push({
          type: same ? 'ok' : 'sub',
          expected: exp[i - 1],
          actual: act[j - 1],
          close: !same && subCost(i - 1, j - 1) === 1
        });
        i -= 1; j -= 1;
      } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
        ops.push({ type: 'miss', expected: exp[i - 1], actual: '' });
        i -= 1;
      } else {
        ops.push({ type: 'extra', expected: '', actual: act[j - 1] });
        j -= 1;
      }
    }
    ops.reverse();

    const okCount = ops.filter(op => op.type === 'ok').length;
    const extraCount = ops.filter(op => op.type === 'extra').length;
    const accuracy = n ? Math.max(0, (okCount - extraCount * 0.5) / n) : (m ? 0 : 1);
    return { ops, accuracy, correct: okCount === n && ops.length === n };
  }

  function countWords(text) {
    return normalizeSpaces(text).split(/\s+/).filter(Boolean).length;
  }

  function isSentenceEnd(text) {
    return /[.!?]["'”’)]*$/.test(normalizeSpaces(text));
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function cleanUnitText(text) {
    return normalizeSpaces(decodeEntities(text))
      .replace(/^>>\s*/, '')
      .replace(/\s*>>\s*/g, ' ')
      .replace(/^[-–—]\s*/, '')
      .replace(/\[[^\]]*\]|\([^)]*(music|applause|laughter|laughs)[^)]*\)/gi, ' ')
      .replace(/[♪♫]/g, ' ')
      .replace(/\s+([,.;!?])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function captionJsonToCues(json) {
    const cues = [];
    for (const event of json?.events || []) {
      if (!event.segs?.length || event.tStartMs == null) continue;
      let text = event.segs.map(seg => seg.utf8 || '').join('');
      text = normalizeSpaces(text.replace(/\n+/g, ' '));
      if (!text || /^\[[^\]]+\]$/.test(text)) continue;
      const start = Number(event.tStartMs) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;
      cues.push({ text, start, end: Math.max(start + 0.15, start + duration) });
    }
    cues.sort((a, b) => a.start - b.start);

    // Auto-generated tracks overlap: each cue lasts until the next line scrolls away.
    // Clip every cue at the next cue's start so the practice unit ends when its words end.
    for (let i = 0; i < cues.length - 1; i += 1) {
      if (cues[i].end > cues[i + 1].start && cues[i + 1].start > cues[i].start) {
        cues[i].end = Math.max(cues[i].start + 0.15, cues[i + 1].start);
      }
    }
    return cues;
  }

  function cuesToUnits(cues, opts = {}) {
    const maxSeconds = opts.maxSeconds ?? MAX_UNIT_SECONDS;
    const maxWords = opts.maxWords ?? MAX_UNIT_WORDS;
    const units = [];
    let buffer = null;

    const flush = () => {
      if (!buffer) return;
      const text = cleanUnitText(buffer.text);
      if (countWords(text) >= MIN_WORDS && /[A-Za-z]/.test(text)) {
        units.push({ text, start: buffer.start, end: buffer.end });
      }
      buffer = null;
    };

    for (const cue of cues) {
      if (buffer) {
        const gap = cue.start - buffer.end;
        if (gap >= GAP_SECONDS && countWords(buffer.text) >= MIN_WORDS) flush();
      }
      if (!buffer) buffer = { ...cue };
      else {
        buffer.text = normalizeSpaces(`${buffer.text} ${cue.text}`);
        buffer.end = Math.max(buffer.end, cue.end);
      }
      const duration = buffer.end - buffer.start;
      const words = countWords(buffer.text);
      if (isSentenceEnd(buffer.text) || duration >= maxSeconds || words >= maxWords ||
        (opts.perCue && words >= MIN_WORDS)) flush();
    }
    flush();

    return units.filter((unit, i, arr) => {
      if (!i) return true;
      const prev = arr[i - 1];
      return !(normalizeSentence(prev.text) === normalizeSentence(unit.text) && Math.abs(prev.start - unit.start) < 1.0);
    });
  }

  function pickCaptionTrack(tracks) {
    if (!tracks?.length) return null;
    const scored = tracks.map((track, index) => {
      const lang = String(track.languageCode || '').toLowerCase();
      const name = track.name?.simpleText || track.name?.runs?.map(r => r.text).join('') || lang;
      let score = 0;
      if (lang === 'en') score += 100;
      else if (lang.startsWith('en-')) score += 90;
      else if (lang.startsWith('en')) score += 80;
      if (track.kind !== 'asr') score += 8;
      if (/english/i.test(name)) score += 10;
      return { track, index, score, name };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    return scored[0].score >= 80 ? scored[0] : null;
  }

  function findBalancedJson(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  function extractPlayerResponse(html) {
    const markers = ['ytInitialPlayerResponse = ', 'var ytInitialPlayerResponse = ', 'window["ytInitialPlayerResponse"] = '];
    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex < 0) continue;
      const start = html.indexOf('{', markerIndex + marker.length);
      if (start < 0) continue;
      const jsonText = findBalancedJson(html, start);
      if (!jsonText) continue;
      try { return JSON.parse(jsonText); } catch (_) { /* try next */ }
    }
    return null;
  }

  const lib = {
    MIN_WORDS, normalizeSpaces, stripOuterPunctuation, normalizeToken, normalizeSentence, tokenize,
    levenshtein, alignWords, countWords, isSentenceEnd, cleanUnitText, captionJsonToCues, cuesToUnits,
    pickCaptionTrack, findBalancedJson, extractPlayerResponse
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.YDT_LIB = lib;
})(typeof globalThis !== 'undefined' ? globalThis : this);
