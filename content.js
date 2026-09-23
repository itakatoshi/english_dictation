(() => {
  const defaults = {
    enabled: false,
    mode: 'full',
    difficulty: 'normal',
    blankCount: 2,
    autoResume: false,
    playbackRate: 1.0
  };

  const stopWords = new Set([
    'a','an','the','i','you','he','she','it','we','they','me','him','her','us','them',
    'my','your','his','its','our','their','this','that','these','those','and','or','but',
    'if','so','to','of','in','on','at','for','from','with','by','as','is','am','are','was',
    'were','be','been','being','do','does','did','have','has','had','can','could','will',
    'would','shall','should','may','might','must','not','no','yes'
  ]);

  const MIN_WORDS = 3;
  const MAX_UNIT_SECONDS = 8.0;
  const MAX_UNIT_WORDS = 20;
  const GAP_SECONDS = 0.75;
  const REPLAY_LEAD_SECONDS = 0.06;
  const REPLAY_TAIL_SECONDS = 0.10;

  let settings = { ...defaults };
  let currentQuestion = null;
  let awaitingAnswer = false;
  let correctCount = 0;
  let askedCount = 0;
  let hintCount = 0;

  let transcriptUnits = [];
  let nextUnitIndex = 0;
  let transcriptTrackLabel = '';
  let transcriptVideoId = '';
  let transcriptLoadToken = 0;
  let replaying = false;
  let replayStopHandler = null;
  let replaySafetyTimer = null;
  let currentVideo = null;

  const normalizeSpaces = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const stripOuterPunctuation = (word) => word.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
  const normalizeToken = (text) => String(text || '')
    .toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']/g, '').trim();
  const normalizeSentence = (text) => normalizeSpaces(text)
    .toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, '')
    .replace(/\s+/g, ' ').trim();

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function getVideo() {
    return document.querySelector('video');
  }

  function getVideoId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v') || '';
    const shorts = url.pathname.match(/^\/shorts\/([^/?]+)/);
    return shorts?.[1] || '';
  }

  function modeLabel() {
    if (settings.mode === 'blanks') return '穴埋め';
    if (settings.mode === 'keyword') return 'キーワード';
    return '全文ディクテーション';
  }

  function getPanelHost() {
    return document.querySelector('#secondary-inner') || document.querySelector('#secondary');
  }

  function mountPanel() {
    const shell = document.getElementById('ydt-shell');
    if (!shell) return false;
    const host = getPanelHost();
    if (!host) return false;
    if (shell.parentElement !== host) host.prepend(shell);
    shell.classList.remove('ydt-fallback');
    return true;
  }

  function makePanel() {
    if (document.getElementById('ydt-shell')) {
      mountPanel();
      return;
    }

    const shell = document.createElement('section');
    shell.id = 'ydt-shell';
    shell.hidden = true;
    shell.innerHTML = `
      <div class="ydt-header">
        <div>
          <div class="ydt-title-row">
            <strong class="ydt-mode-pill">全文ディクテーション</strong>
            <span class="ydt-question-no">待機中</span>
          </div>
          <div class="ydt-sync">字幕を読み込み中…</div>
        </div>
        <button class="ydt-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="ydt-body">
        <div class="ydt-idle">動画を再生すると、右側に問題が出ます。</div>
        <div class="ydt-question-area" hidden>
          <div class="ydt-full-guide" aria-hidden="true"></div>
          <div class="ydt-answer-box" contenteditable="true" role="textbox" aria-label="Dictation answer" data-placeholder="聞こえた英文を入力…"></div>
          <div class="ydt-blank-question"></div>
          <div class="ydt-blank-inputs"></div>
          <div class="ydt-feedback"></div>
        </div>
      </div>
      <div class="ydt-toolbar" hidden>
        <button class="ydt-listen" type="button" title="この文だけ聞き直す">🔊 聞き直す</button>
        <label class="ydt-rate-label">速度
          <select class="ydt-rate">
            <option value="0.75">0.75x</option>
            <option value="1">1.0x</option>
            <option value="1.2">1.2x</option>
            <option value="1.5">1.5x</option>
          </select>
        </label>
        <button class="ydt-hint" type="button">1文字ヒント</button>
        <button class="ydt-pass" type="button">パス</button>
        <button class="ydt-check" type="button">答え合わせ</button>
      </div>
    `;

    const host = getPanelHost();
    (host || document.body).prepend(shell);
    if (!host) shell.classList.add('ydt-fallback');

    shell.querySelector('.ydt-check').addEventListener('click', checkAnswers);
    shell.querySelector('.ydt-listen').addEventListener('click', replay);
    shell.querySelector('.ydt-hint').addEventListener('click', revealOneCharacter);
    shell.querySelector('.ydt-pass').addEventListener('click', finishQuestion);
    shell.querySelector('.ydt-close').addEventListener('click', () => chrome.storage.sync.set({ enabled: false }));
    shell.querySelector('.ydt-rate').addEventListener('change', (event) => {
      const rate = Number(event.target.value) || 1;
      settings.playbackRate = rate;
      chrome.storage.sync.set({ playbackRate: rate });
    });
    shell.querySelector('.ydt-answer-box').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        checkAnswers();
      }
    });
  }

  function setSyncStatus(text, isError = false) {
    makePanel();
    const el = document.querySelector('#ydt-shell .ydt-sync');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  function renderIdle(message = '動画を再生すると、右側に問題が出ます。') {
    makePanel();
    const shell = document.getElementById('ydt-shell');
    if (!shell) return;
    shell.hidden = !settings.enabled;
    shell.querySelector('.ydt-idle').hidden = false;
    shell.querySelector('.ydt-idle').textContent = message;
    shell.querySelector('.ydt-question-area').hidden = true;
    shell.querySelector('.ydt-toolbar').hidden = true;
    shell.querySelector('.ydt-question-no').textContent = '待機中';
  }

  function scoreWord(word, index, length) {
    const clean = normalizeToken(word);
    let score = Math.min(clean.length, 10);
    if (!stopWords.has(clean)) score += 8;
    if (clean.length >= 6) score += 5;
    if (index > 0 && index < length - 1) score += 2;
    if (/ing$|ed$|ly$|tion$|ment$|ous$|ive$|able$/.test(clean)) score += 3;
    return score + Math.random() * 1.5;
  }

  function chooseBlankIndexes(words, countOverride = null) {
    const eligible = words
      .map((word, index) => ({ word, index, clean: normalizeToken(word) }))
      .filter(x => x.clean.length >= (settings.difficulty === 'easy' ? 5 : 3))
      .filter(x => /[a-z]/i.test(x.clean));

    let pool = eligible;
    if (settings.difficulty !== 'hard') {
      const meaningful = eligible.filter(x => !stopWords.has(x.clean));
      if (meaningful.length) pool = meaningful;
    }

    const count = countOverride ?? settings.blankCount;
    return pool
      .map(x => ({ ...x, score: scoreWord(x.word, x.index, words.length) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(count, pool.length))
      .map(x => x.index)
      .sort((a, b) => a - b);
  }

  function buildQuestion(unit, index) {
    const caption = normalizeSpaces(unit.text);
    const words = caption.split(/\s+/).filter(Boolean);
    if (words.length < MIN_WORDS) return null;

    const blankCount = settings.mode === 'keyword' ? 1 : settings.blankCount;
    const indexes = chooseBlankIndexes(words, blankCount);
    const answers = indexes.map(i => stripOuterPunctuation(words[i]));
    const indexToBlank = new Map(indexes.map((idx, n) => [idx, n]));
    const display = words.map((word, wordIndex) => {
      if (!indexToBlank.has(wordIndex)) return word;
      const clean = answers[indexToBlank.get(wordIndex)];
      return '_'.repeat(Math.max(4, Math.min(clean.length, 14)));
    }).join(' ');

    return {
      source: caption,
      words,
      indexes,
      answers,
      display,
      startTime: unit.start,
      endTime: unit.end,
      index
    };
  }

  function buildUnderlineGuide(sentence) {
    return normalizeSpaces(sentence).split(' ').filter(Boolean).map((word) => {
      const clean = stripOuterPunctuation(word) || word;
      const length = Math.max(1, [...clean].length);
      const width = Math.max(16, Math.min(72, 7 + length * 6.5));
      return `<span class="ydt-guide-word" style="--ydt-guide-width:${width}px" title="${length}文字"></span>`;
    }).join('');
  }

  function focusEditableEnd(el) {
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function showQuestion(question) {
    if (!question || awaitingAnswer) return;
    makePanel();
    mountPanel();
    stopReplay();

    currentQuestion = question;
    awaitingAnswer = true;
    hintCount = 0;
    askedCount += 1;

    const video = getVideo();
    if (video && !video.paused) video.pause();

    const shell = document.getElementById('ydt-shell');
    shell.hidden = false;
    shell.querySelector('.ydt-idle').hidden = true;
    shell.querySelector('.ydt-question-area').hidden = false;
    shell.querySelector('.ydt-toolbar').hidden = false;
    shell.querySelector('.ydt-mode-pill').textContent = modeLabel();
    shell.querySelector('.ydt-question-no').textContent = `${question.index + 1} / ${transcriptUnits.length}`;
    shell.querySelector('.ydt-rate').value = String(settings.playbackRate);
    shell.querySelector('.ydt-feedback').textContent = '';
    shell.querySelector('.ydt-check').textContent = '答え合わせ';
    shell.querySelector('.ydt-check').dataset.state = 'check';

    const answerBox = shell.querySelector('.ydt-answer-box');
    const fullGuide = shell.querySelector('.ydt-full-guide');
    const blankQuestion = shell.querySelector('.ydt-blank-question');
    const blankInputs = shell.querySelector('.ydt-blank-inputs');
    answerBox.className = 'ydt-answer-box';
    answerBox.innerHTML = '';
    answerBox.contentEditable = 'true';
    blankInputs.innerHTML = '';

    if (settings.mode === 'full') {
      fullGuide.style.display = 'flex';
      fullGuide.innerHTML = buildUnderlineGuide(question.source);
      answerBox.style.display = 'block';
      blankQuestion.style.display = 'none';
      blankInputs.style.display = 'none';
      requestAnimationFrame(() => focusEditableEnd(answerBox));
    } else {
      fullGuide.style.display = 'none';
      answerBox.style.display = 'none';
      blankQuestion.style.display = 'block';
      blankInputs.style.display = 'flex';
      blankQuestion.textContent = question.display;
      question.answers.forEach((_, i) => {
        const input = document.createElement('input');
        input.className = 'ydt-answer';
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = settings.mode === 'keyword' ? '聞こえた単語' : `Blank ${i + 1}`;
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') checkAnswers();
        });
        blankInputs.appendChild(input);
      });
      requestAnimationFrame(() => blankInputs.querySelector('input')?.focus());
    }
  }

  function correctionHtml(expected, actual) {
    const expectedWords = normalizeSpaces(expected).split(' ');
    const actualWords = normalizeSpaces(actual).split(' ');
    const max = Math.max(expectedWords.length, actualWords.length);
    const parts = [];
    for (let i = 0; i < max; i += 1) {
      const e = expectedWords[i] || '';
      const a = actualWords[i] || '';
      if (e && normalizeToken(e) === normalizeToken(a)) {
        parts.push(`<span class="ydt-word-correct">${escapeHtml(e)}</span>`);
      } else if (!e && a) {
        parts.push(`<span class="ydt-word-extra">${escapeHtml(a)}</span>`);
      } else if (e && !a) {
        parts.push(`<span class="ydt-word-fix"><span class="ydt-word-missing">∅</span><span class="ydt-arrow">→</span>${escapeHtml(e)}</span>`);
      } else {
        parts.push(`<span class="ydt-word-fix"><span class="ydt-word-user">${escapeHtml(a)}</span><span class="ydt-arrow">→</span>${escapeHtml(e)}</span>`);
      }
    }
    return parts.join(' ');
  }

  function checkAnswers() {
    if (!currentQuestion) return;
    const shell = document.getElementById('ydt-shell');
    const checkButton = shell.querySelector('.ydt-check');

    if (checkButton.dataset.state === 'next') {
      finishQuestion();
      return;
    }

    let allCorrect = true;
    if (settings.mode === 'full') {
      const input = shell.querySelector('.ydt-answer-box');
      const actual = input.innerText;
      allCorrect = normalizeSentence(actual) === normalizeSentence(currentQuestion.source);
      input.contentEditable = 'false';
      input.classList.toggle('correct', allCorrect);
      input.classList.toggle('wrong', !allCorrect);
      input.innerHTML = correctionHtml(currentQuestion.source, actual);
    } else {
      const inputs = [...shell.querySelectorAll('.ydt-answer')];
      inputs.forEach((input, i) => {
        const ok = normalizeToken(input.value) === normalizeToken(currentQuestion.answers[i]);
        input.classList.toggle('correct', ok);
        input.classList.toggle('wrong', !ok);
        if (!ok) allCorrect = false;
      });
      shell.querySelector('.ydt-feedback').innerHTML = `正解: <strong>${escapeHtml(currentQuestion.source)}</strong>`;
    }

    if (allCorrect) {
      correctCount += 1;
      shell.querySelector('.ydt-feedback').textContent = '✅ 正解です';
      if (settings.autoResume) {
        setTimeout(finishQuestion, 650);
        return;
      }
    } else {
      shell.querySelector('.ydt-feedback').textContent = '赤い箇所を確認して、必要ならもう一度聞いてください。';
    }

    checkButton.textContent = '次へ';
    checkButton.dataset.state = 'next';
  }

  function revealOneCharacter() {
    if (!currentQuestion) return;
    const shell = document.getElementById('ydt-shell');

    if (settings.mode === 'full') {
      const input = shell.querySelector('.ydt-answer-box');
      if (input.contentEditable === 'false') return;
      const answer = currentQuestion.source;
      const typed = input.innerText;
      let prefix = 0;
      while (prefix < answer.length && prefix < typed.length && answer[prefix].toLowerCase() === typed[prefix].toLowerCase()) prefix += 1;
      const next = answer.slice(0, prefix + 1) + typed.slice(Math.min(prefix + 1, typed.length));
      input.textContent = next;
      hintCount += 1;
      focusEditableEnd(input);
    } else {
      const inputs = [...shell.querySelectorAll('.ydt-answer')];
      for (let i = 0; i < inputs.length; i += 1) {
        const target = currentQuestion.answers[i];
        const input = inputs[i];
        if (input.value.length < target.length) {
          input.value = target.slice(0, input.value.length + 1);
          hintCount += 1;
          input.focus();
          break;
        }
      }
    }

    shell.querySelector('.ydt-feedback').textContent = `ヒント ${hintCount}文字使用`;
  }

  function stopReplay() {
    const video = getVideo();
    if (video && replayStopHandler) video.removeEventListener('timeupdate', replayStopHandler);
    replayStopHandler = null;
    if (replaySafetyTimer) clearTimeout(replaySafetyTimer);
    replaySafetyTimer = null;
    replaying = false;
    document.querySelector('#ydt-shell .ydt-listen')?.classList.remove('playing');
  }

  function replay() {
    const video = getVideo();
    if (!video || !currentQuestion) return;

    stopReplay();
    replaying = true;
    const start = Math.max(0, currentQuestion.startTime - REPLAY_LEAD_SECONDS);
    const stopAt = Math.max(start + 0.25, currentQuestion.endTime + REPLAY_TAIL_SECONDS);
    const rate = Number(settings.playbackRate) || 1;

    video.playbackRate = rate;
    video.currentTime = start;
    const listen = document.querySelector('#ydt-shell .ydt-listen');
    listen?.classList.add('playing');

    replayStopHandler = () => {
      if (!awaitingAnswer || video.currentTime >= stopAt) {
        video.pause();
        stopReplay();
        focusAnswer();
      }
    };
    video.addEventListener('timeupdate', replayStopHandler);

    replaySafetyTimer = setTimeout(() => {
      if (awaitingAnswer) video.pause();
      stopReplay();
      focusAnswer();
    }, Math.max(1200, (((stopAt - start) / rate) + 1.0) * 1000));

    video.play().catch(() => stopReplay());
  }

  function focusAnswer() {
    if (settings.mode === 'full') focusEditableEnd(document.querySelector('#ydt-shell .ydt-answer-box'));
    else document.querySelector('#ydt-shell .ydt-answer')?.focus();
  }

  function finishQuestion() {
    const finished = currentQuestion;
    awaitingAnswer = false;
    currentQuestion = null;
    stopReplay();

    const video = getVideo();
    if (finished) nextUnitIndex = Math.max(nextUnitIndex, finished.index + 1);
    renderIdle('次の文を聞いてください。');

    if (video) {
      video.playbackRate = 1;
      if (finished && video.currentTime < finished.endTime - 0.08) video.currentTime = finished.endTime + 0.03;
      video.play().catch(() => {});
    }
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
    const markers = [
      'ytInitialPlayerResponse = ',
      'var ytInitialPlayerResponse = ',
      'window["ytInitialPlayerResponse"] = '
    ];
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

  async function fetchCaptionJson(track) {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    const response = await fetch(url.toString(), { credentials: 'include' });
    if (!response.ok) throw new Error(`字幕取得 HTTP ${response.status}`);
    return response.json();
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
      const end = Math.max(start + 0.15, start + duration);
      cues.push({ text, start, end });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  function countWords(text) {
    return normalizeSpaces(text).split(/\s+/).filter(Boolean).length;
  }

  function isSentenceEnd(text) {
    return /[.!?]["'”’)]*$/.test(normalizeSpaces(text));
  }

  function cleanUnitText(text) {
    return normalizeSpaces(text)
      .replace(/^[-–—]\s*/, '')
      .replace(/\s+([,.;!?])/g, '$1');
  }

  function cuesToUnits(cues) {
    const units = [];
    let buffer = null;

    const flush = () => {
      if (!buffer) return;
      const text = cleanUnitText(buffer.text);
      const words = countWords(text);
      if (words >= MIN_WORDS && /[A-Za-z]/.test(text)) {
        units.push({ text, start: buffer.start, end: buffer.end });
      }
      buffer = null;
    };

    for (const cue of cues) {
      if (!buffer) {
        buffer = { ...cue };
      } else {
        const gap = cue.start - buffer.end;
        const shouldBreakBefore = gap >= GAP_SECONDS && countWords(buffer.text) >= MIN_WORDS;
        if (shouldBreakBefore) flush();

        if (!buffer) buffer = { ...cue };
        else {
          buffer.text = normalizeSpaces(`${buffer.text} ${cue.text}`);
          buffer.end = Math.max(buffer.end, cue.end);
        }
      }

      const duration = buffer.end - buffer.start;
      const words = countWords(buffer.text);
      if (isSentenceEnd(buffer.text) || duration >= MAX_UNIT_SECONDS || words >= MAX_UNIT_WORDS) flush();
    }
    flush();

    return units.filter((unit, i, arr) => {
      if (!i) return true;
      const prev = arr[i - 1];
      return !(normalizeSentence(prev.text) === normalizeSentence(unit.text) && Math.abs(prev.start - unit.start) < 1.0);
    });
  }

  async function loadTranscript() {
    const videoId = getVideoId();
    if (!settings.enabled || !videoId) return;
    const token = ++transcriptLoadToken;
    transcriptUnits = [];
    transcriptVideoId = videoId;
    setSyncStatus('英語字幕のタイムコードを読み込み中…');
    renderIdle('字幕を準備しています…');

    try {
      const pageResponse = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
      const html = await pageResponse.text();
      if (token !== transcriptLoadToken || videoId !== getVideoId()) return;

      const player = extractPlayerResponse(html);
      const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const picked = pickCaptionTrack(tracks);
      if (!picked) throw new Error('英語字幕トラックが見つかりません');

      const json = await fetchCaptionJson(picked.track);
      if (token !== transcriptLoadToken || videoId !== getVideoId()) return;

      const cues = captionJsonToCues(json);
      transcriptUnits = cuesToUnits(cues);
      if (!transcriptUnits.length) throw new Error('字幕から練習文を作れませんでした');

      transcriptTrackLabel = picked.name || picked.track.languageCode || 'English';
      setSyncStatus(`同期済み: ${transcriptTrackLabel} / ${transcriptUnits.length}文`);
      syncNextUnitToCurrentTime(true);
      renderIdle('動画を再生してください。字幕の区間終了で自動停止します。');
    } catch (error) {
      transcriptUnits = [];
      setSyncStatus(error?.message || '字幕の読み込みに失敗しました', true);
      renderIdle('この動画では英語字幕を取得できませんでした。');
    }
  }

  function syncNextUnitToCurrentTime(skipPartial = false) {
    const video = getVideo();
    const t = video?.currentTime || 0;
    let index = transcriptUnits.findIndex(unit => skipPartial ? unit.start >= t - 0.08 : unit.end > t + 0.05);
    if (index < 0) index = transcriptUnits.length;
    nextUnitIndex = index;
  }

  function onVideoTimeUpdate() {
    const video = getVideo();
    if (!settings.enabled || !video || replaying || awaitingAnswer || !transcriptUnits.length) return;

    while (nextUnitIndex < transcriptUnits.length && video.currentTime > transcriptUnits[nextUnitIndex].end + 0.9) {
      nextUnitIndex += 1;
    }
    if (nextUnitIndex >= transcriptUnits.length) return;

    const unit = transcriptUnits[nextUnitIndex];
    if (video.currentTime >= unit.end - 0.07 && video.currentTime <= unit.end + 0.9) {
      video.pause();
      const question = buildQuestion(unit, nextUnitIndex);
      if (question) showQuestion(question);
      else {
        nextUnitIndex += 1;
        video.play().catch(() => {});
      }
    }
  }

  function attachVideoEvents() {
    const video = getVideo();
    if (!video || video === currentVideo) return;
    if (currentVideo) {
      currentVideo.removeEventListener('timeupdate', onVideoTimeUpdate);
      currentVideo.removeEventListener('seeked', onVideoSeeked);
    }
    currentVideo = video;
    currentVideo.addEventListener('timeupdate', onVideoTimeUpdate);
    currentVideo.addEventListener('seeked', onVideoSeeked);
  }

  function onVideoSeeked() {
    if (!replaying && !awaitingAnswer) syncNextUnitToCurrentTime(false);
  }

  function applySettings(next) {
    const wasEnabled = settings.enabled;
    settings = { ...defaults, ...next };
    makePanel();
    mountPanel();

    if (!settings.enabled) {
      awaitingAnswer = false;
      currentQuestion = null;
      stopReplay();
      transcriptUnits = [];
      transcriptLoadToken += 1;
      document.body.classList.remove('ydt-enabled');
      const shell = document.getElementById('ydt-shell');
      if (shell) shell.hidden = true;
      return;
    }

    document.body.classList.add('ydt-enabled');
    const shell = document.getElementById('ydt-shell');
    if (shell) shell.hidden = false;
    shell?.querySelector('.ydt-rate')?.setAttribute('value', String(settings.playbackRate));
    attachVideoEvents();

    if (!wasEnabled || transcriptVideoId !== getVideoId() || !transcriptUnits.length) loadTranscript();
  }

  chrome.storage.sync.get(defaults, applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
    applySettings(next);
  });

  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => {
      makePanel();
      mountPanel();
      attachVideoEvents();
      if (settings.enabled && transcriptVideoId !== getVideoId()) loadTranscript();
    }, 350);
  });

  setInterval(() => {
    makePanel();
    mountPanel();
    attachVideoEvents();
    if (settings.enabled && getVideoId() && transcriptVideoId !== getVideoId()) loadTranscript();
  }, 1000);

  makePanel();
  attachVideoEvents();
})();
