(() => {
  const L = globalThis.YDT_LIB;

  const defaults = {
    enabled: false,
    mode: 'full',
    difficulty: 'normal',
    blankCount: 2,
    autoResume: false,
    playbackRate: 1.0,
    unitLength: 'normal'
  };

  const UNIT_LENGTHS = {
    short: { maxSeconds: 4.5, maxWords: 10, perCue: true },
    normal: { maxSeconds: 8.0, maxWords: 20 },
    long: { maxSeconds: 14.0, maxWords: 35 }
  };

  const stopWords = new Set([
    'a','an','the','i','you','he','she','it','we','they','me','him','her','us','them',
    'my','your','his','its','our','their','this','that','these','those','and','or','but',
    'if','so','to','of','in','on','at','for','from','with','by','as','is','am','are','was',
    'were','be','been','being','do','does','did','have','has','had','can','could','will',
    'would','shall','should','may','might','must','not','no','yes'
  ]);

  // Innertube clients whose caption URLs work without a PO token.
  // The web page's own caption URLs (exp=xpe) now return an empty body when fetched directly.
  const INNERTUBE_CLIENTS = [
    { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 },
    { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2' }
  ];

  const STOP_EARLY_SECONDS = 0.03;
  const REPLAY_LEAD_SECONDS = 0.06;
  const REPLAY_TAIL_SECONDS = 0.10;
  const MISTAKE_LOG_LIMIT = 300;

  let settings = { ...defaults };
  let currentQuestion = null;
  let awaitingAnswer = false;
  let answered = false;
  let hintCount = 0;
  const stats = { asked: 0, correct: 0, accuracySum: 0 };

  let transcriptCues = [];
  let transcriptUnits = [];
  let nextUnitIndex = 0;
  let transcriptTrackLabel = '';
  let transcriptVideoId = '';
  let transcriptLoadToken = 0;
  const cueCache = new Map();

  let replaying = false;
  let replayStopAt = 0;
  let replaySafetyTimer = null;
  let rateBeforeReplay = null;
  let currentVideo = null;
  let rafId = 0;
  let autoNextTimer = null;

  const { normalizeSpaces, stripOuterPunctuation, normalizeToken } = L;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  const getVideo = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  const shellEl = () => document.getElementById('ydt-shell');
  const q = (selector) => shellEl()?.querySelector(selector);

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
    const shell = shellEl();
    if (!shell) return false;
    const host = getPanelHost();
    if (!host || host.offsetParent === null) {
      // Theater mode / narrow layouts hide #secondary: float the panel instead.
      if (shell.parentElement !== document.body) document.body.appendChild(shell);
      shell.classList.add('ydt-fallback');
      return true;
    }
    if (shell.parentElement !== host) host.prepend(shell);
    shell.classList.remove('ydt-fallback');
    return true;
  }

  function makePanel() {
    if (shellEl()) {
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
          <div class="ydt-stats"></div>
        </div>
        <button class="ydt-close" type="button" aria-label="Close" title="拡張をOFF">×</button>
      </div>
      <div class="ydt-body">
        <div class="ydt-idle">動画を再生すると、右側に問題が出ます。</div>
        <div class="ydt-question-area" hidden>
          <div class="ydt-full-guide" aria-hidden="true"></div>
          <div class="ydt-answer-box" contenteditable="plaintext-only" role="textbox" aria-label="Dictation answer" data-placeholder="聞こえた英文を入力…"></div>
          <div class="ydt-blank-question"></div>
          <div class="ydt-blank-inputs"></div>
          <div class="ydt-feedback"></div>
          <div class="ydt-reveal" hidden></div>
        </div>
      </div>
      <div class="ydt-toolbar" hidden>
        <div class="ydt-toolbar-row">
          <button class="ydt-prev" type="button" title="前の文に戻る (Alt+B)">⏮</button>
          <button class="ydt-listen" type="button" title="この文だけ聞き直す (Ctrl+Space)">🔊 聞き直す</button>
          <label class="ydt-rate-label">速度
            <select class="ydt-rate">
              <option value="0.5">0.5x</option>
              <option value="0.75">0.75x</option>
              <option value="1">1.0x</option>
              <option value="1.2">1.2x</option>
              <option value="1.5">1.5x</option>
            </select>
          </label>
        </div>
        <div class="ydt-toolbar-row">
          <button class="ydt-hint" type="button" title="Alt+H">1文字ヒント</button>
          <button class="ydt-pass" type="button" title="答えを見る (Alt+S)">答えを見る</button>
          <button class="ydt-check" type="button" title="Enter">答え合わせ</button>
        </div>
        <div class="ydt-keys">Enter: 答え合わせ/次へ · Ctrl+Space: 聞き直す · Alt+H: ヒント · Alt+S: 答え · Alt+B: 前の文</div>
      </div>
    `;

    document.body.appendChild(shell);
    mountPanel();

    q('.ydt-check').addEventListener('click', checkAnswers);
    q('.ydt-listen').addEventListener('click', replay);
    q('.ydt-hint').addEventListener('click', revealOneCharacter);
    q('.ydt-pass').addEventListener('click', revealAnswer);
    q('.ydt-prev').addEventListener('click', goToPreviousUnit);
    q('.ydt-close').addEventListener('click', () => chrome.storage.sync.set({ enabled: false }));
    q('.ydt-rate').addEventListener('change', (event) => {
      const rate = Number(event.target.value) || 1;
      settings.playbackRate = rate;
      chrome.storage.sync.set({ playbackRate: rate });
    });

    const answerBox = q('.ydt-answer-box');
    // Older Chrome builds ignore plaintext-only; force plain-text paste either way.
    answerBox.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
    });

    // Keep typing inside the panel away from YouTube's hotkeys (k, j, f, m, arrows …).
    shell.addEventListener('keydown', onPanelKeydown);
    shell.addEventListener('keyup', (event) => event.stopPropagation());
    shell.addEventListener('keypress', (event) => event.stopPropagation());
  }

  function onPanelKeydown(event) {
    event.stopPropagation();
    if (!currentQuestion) return;
    if (event.isComposing) return;
    const target = event.target;
    const isOtherControl = target.tagName === 'SELECT' ||
      (target.tagName === 'BUTTON' && !target.classList.contains('ydt-check'));

    if (event.ctrlKey && event.code === 'Space') {
      event.preventDefault();
      replay();
    } else if (event.altKey && event.code === 'KeyH') {
      event.preventDefault();
      revealOneCharacter();
    } else if (event.altKey && event.code === 'KeyS') {
      event.preventDefault();
      revealAnswer();
    } else if (event.altKey && event.code === 'KeyB') {
      event.preventDefault();
      goToPreviousUnit();
    } else if (event.key === 'Enter' && !event.shiftKey && !isOtherControl) {
      event.preventDefault();
      checkAnswers();
    }
  }

  const panelShouldShow = () => settings.enabled && Boolean(getVideoId());

  function setSyncStatus(text, isError = false) {
    makePanel();
    const el = q('.ydt-sync');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  function renderStats() {
    const el = q('.ydt-stats');
    if (!el) return;
    if (!stats.asked) {
      el.textContent = '';
      return;
    }
    const avg = Math.round((stats.accuracySum / stats.asked) * 100);
    el.textContent = `正解 ${stats.correct} / ${stats.asked} · 平均正答率 ${avg}%`;
  }

  function renderIdle(message = '動画を再生すると、右側に問題が出ます。') {
    makePanel();
    const shell = shellEl();
    if (!shell) return;
    shell.hidden = !panelShouldShow();
    q('.ydt-idle').hidden = false;
    q('.ydt-idle').textContent = message;
    q('.ydt-question-area').hidden = true;
    q('.ydt-toolbar').hidden = true;
    q('.ydt-question-no').textContent = '待機中';
    renderStats();
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

  function chooseBlankIndexes(words, count) {
    const eligible = words
      .map((word, index) => ({ word, index, clean: normalizeToken(word) }))
      .filter(x => x.clean.length >= (settings.difficulty === 'easy' ? 5 : 3))
      .filter(x => /[a-z]/i.test(x.clean));

    let pool = eligible;
    if (settings.difficulty !== 'hard') {
      const meaningful = eligible.filter(x => !stopWords.has(x.clean));
      if (meaningful.length) pool = meaningful;
    }

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
    if (words.length < L.MIN_WORDS) return null;

    const count = settings.mode === 'keyword' ? 1 : settings.blankCount;
    const indexes = settings.mode === 'full' ? [] : chooseBlankIndexes(words, count);
    if (settings.mode !== 'full' && !indexes.length) return null;
    const answers = indexes.map(i => stripOuterPunctuation(words[i]));
    const indexToBlank = new Map(indexes.map((idx, n) => [idx, n]));

    // Keep the punctuation around a blank visible: "(______)," instead of hiding it.
    const displayParts = words.map((word, wordIndex) => {
      if (!indexToBlank.has(wordIndex)) return { text: word };
      const n = indexToBlank.get(wordIndex);
      const clean = answers[n];
      const at = word.indexOf(clean);
      return {
        blank: n,
        before: at > 0 ? word.slice(0, at) : '',
        after: at >= 0 ? word.slice(at + clean.length) : '',
        width: Math.max(4, Math.min(clean.length, 14))
      };
    });

    return {
      source: caption,
      words,
      indexes,
      answers,
      displayParts,
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

  function renderBlankQuestion(question) {
    return question.displayParts.map((part) => {
      if (part.blank === undefined) return escapeHtml(part.text);
      return `${escapeHtml(part.before)}<span class="ydt-blank-slot" data-blank="${part.blank}">${'_'.repeat(part.width)}</span>${escapeHtml(part.after)}`;
    }).join(' ');
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
    if (!question) return;
    makePanel();
    mountPanel();
    stopReplay();
    clearTimeout(autoNextTimer);

    currentQuestion = question;
    awaitingAnswer = true;
    answered = false;
    hintCount = 0;

    const video = getVideo();
    if (video && !video.paused) video.pause();

    const shell = shellEl();
    shell.hidden = false;
    q('.ydt-idle').hidden = true;
    q('.ydt-question-area').hidden = false;
    q('.ydt-toolbar').hidden = false;
    q('.ydt-mode-pill').textContent = modeLabel();
    q('.ydt-question-no').textContent = `${question.index + 1} / ${transcriptUnits.length}`;
    q('.ydt-rate').value = String(settings.playbackRate);
    q('.ydt-feedback').textContent = '';
    q('.ydt-reveal').hidden = true;
    q('.ydt-reveal').innerHTML = '';
    q('.ydt-check').textContent = '答え合わせ';
    q('.ydt-check').dataset.state = 'check';
    q('.ydt-hint').disabled = false;
    q('.ydt-pass').disabled = false;
    q('.ydt-prev').disabled = question.index <= 0;

    const answerBox = q('.ydt-answer-box');
    const fullGuide = q('.ydt-full-guide');
    const blankQuestion = q('.ydt-blank-question');
    const blankInputs = q('.ydt-blank-inputs');
    answerBox.className = 'ydt-answer-box';
    answerBox.innerHTML = '';
    answerBox.contentEditable = 'plaintext-only';
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
      blankQuestion.innerHTML = renderBlankQuestion(question);
      question.answers.forEach((answer, i) => {
        const input = document.createElement('input');
        input.className = 'ydt-answer';
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        const letters = `${[...answer].length}文字`;
        input.placeholder = settings.mode === 'keyword' ? `聞こえた単語 (${letters})` : `${i + 1}: ${letters}`;
        input.addEventListener('focus', () => highlightSlot(i));
        blankInputs.appendChild(input);
      });
      requestAnimationFrame(() => blankInputs.querySelector('input')?.focus());
    }
  }

  function highlightSlot(n) {
    shellEl()?.querySelectorAll('.ydt-blank-slot').forEach((slot) => {
      slot.classList.toggle('active', Number(slot.dataset.blank) === n);
    });
  }

  function correctionHtml(ops) {
    return ops.map((op) => {
      if (op.type === 'ok') return `<span class="ydt-word-correct">${escapeHtml(op.expected)}</span>`;
      if (op.type === 'extra') return `<span class="ydt-word-extra" title="余分な語">${escapeHtml(op.actual)}</span>`;
      if (op.type === 'miss') {
        return `<span class="ydt-word-fix ydt-missing" title="聞き逃し"><span class="ydt-word-missing">＋</span>${escapeHtml(op.expected)}</span>`;
      }
      const cls = op.close ? 'ydt-word-fix ydt-close-miss' : 'ydt-word-fix';
      const title = op.close ? 'スペルミス' : '聞き間違い';
      return `<span class="${cls}" title="${title}"><span class="ydt-word-user">${escapeHtml(op.actual)}</span><span class="ydt-arrow">→</span>${escapeHtml(op.expected)}</span>`;
    }).join(' ');
  }

  function summarizeOps(ops) {
    const miss = ops.filter(op => op.type === 'miss').length;
    const sub = ops.filter(op => op.type === 'sub' && !op.close).length;
    const spell = ops.filter(op => op.type === 'sub' && op.close).length;
    const extra = ops.filter(op => op.type === 'extra').length;
    const parts = [];
    if (sub) parts.push(`聞き間違い ${sub}`);
    if (spell) parts.push(`スペル ${spell}`);
    if (miss) parts.push(`抜け ${miss}`);
    if (extra) parts.push(`余分 ${extra}`);
    return parts.join(' · ');
  }

  function recordResult(accuracy, correct, typed) {
    stats.asked += 1;
    stats.accuracySum += accuracy;
    if (correct) stats.correct += 1;
    renderStats();

    const entry = {
      videoId: getVideoId(),
      title: document.title.replace(/ - YouTube$/, ''),
      start: currentQuestion.startTime,
      sentence: currentQuestion.source,
      typed,
      accuracy: Math.round(accuracy * 100),
      hints: hintCount,
      mode: settings.mode,
      at: Date.now()
    };

    chrome.storage.local.get({ ydtHistory: { total: 0, correct: 0 }, ydtMistakes: [] }, (data) => {
      const history = data.ydtHistory;
      history.total += 1;
      if (correct) history.correct += 1;
      const update = { ydtHistory: history };
      if (!correct) update.ydtMistakes = [entry, ...data.ydtMistakes].slice(0, MISTAKE_LOG_LIMIT);
      chrome.storage.local.set(update);
    });
  }

  function markAnswered() {
    answered = true;
    q('.ydt-check').textContent = '次へ ▶';
    q('.ydt-check').dataset.state = 'next';
    q('.ydt-hint').disabled = true;
    q('.ydt-pass').disabled = true;
    q('.ydt-check').focus();
  }

  function checkAnswers() {
    if (!currentQuestion) return;
    const checkButton = q('.ydt-check');

    if (checkButton.dataset.state === 'next') {
      finishQuestion();
      return;
    }

    let allCorrect = true;
    let accuracy = 1;
    let typed = '';
    const feedback = q('.ydt-feedback');

    if (settings.mode === 'full') {
      const input = q('.ydt-answer-box');
      typed = normalizeSpaces(input.innerText);
      if (!typed) {
        feedback.textContent = 'まだ入力がありません。分からない場合は「答えを見る」を押してください。';
        return;
      }
      const result = L.alignWords(currentQuestion.source, typed);
      allCorrect = result.correct;
      accuracy = result.accuracy;
      input.contentEditable = 'false';
      input.classList.toggle('correct', allCorrect);
      input.classList.toggle('wrong', !allCorrect);
      input.innerHTML = correctionHtml(result.ops);
      if (!allCorrect) {
        feedback.textContent = `正答率 ${Math.round(accuracy * 100)}% · ${summarizeOps(result.ops)}`;
        showReveal(currentQuestion.source);
      }
    } else {
      const inputs = [...shellEl().querySelectorAll('.ydt-answer')];
      let ok = 0;
      inputs.forEach((input, i) => {
        const good = normalizeToken(input.value) === normalizeToken(currentQuestion.answers[i]);
        input.classList.toggle('correct', good);
        input.classList.toggle('wrong', !good);
        input.readOnly = true;
        if (good) ok += 1;
        else allCorrect = false;
      });
      typed = inputs.map(input => input.value).join(' / ');
      accuracy = inputs.length ? ok / inputs.length : 0;
      fillBlankSlots();
      if (!allCorrect) {
        feedback.textContent = `${ok} / ${inputs.length} 正解`;
        showReveal(currentQuestion.source);
      }
    }

    recordResult(accuracy, allCorrect, typed);

    if (allCorrect) {
      feedback.textContent = hintCount ? `✅ 正解です（ヒント ${hintCount}文字）` : '✅ 正解です';
      markAnswered();
      if (settings.autoResume) autoNextTimer = setTimeout(finishQuestion, 700);
      return;
    }
    markAnswered();
  }

  function fillBlankSlots() {
    shellEl()?.querySelectorAll('.ydt-blank-slot').forEach((slot) => {
      const n = Number(slot.dataset.blank);
      const input = shellEl().querySelectorAll('.ydt-answer')[n];
      const good = input && normalizeToken(input.value) === normalizeToken(currentQuestion.answers[n]);
      slot.textContent = currentQuestion.answers[n];
      slot.classList.add(good ? 'correct' : 'wrong');
    });
  }

  function showReveal(sentence) {
    const el = q('.ydt-reveal');
    el.hidden = false;
    el.innerHTML = `<span class="ydt-reveal-label">正解</span> ${escapeHtml(sentence)}`;
  }

  // "答えを見る": give up on this one, count it as a miss and show the sentence.
  function revealAnswer() {
    if (!currentQuestion || answered) return;
    let typed = '';
    if (settings.mode === 'full') {
      const input = q('.ydt-answer-box');
      typed = normalizeSpaces(input.innerText);
      input.contentEditable = 'false';
      input.classList.add('wrong');
      if (typed) input.innerHTML = correctionHtml(L.alignWords(currentQuestion.source, typed).ops);
    } else {
      const inputs = [...shellEl().querySelectorAll('.ydt-answer')];
      typed = inputs.map(input => input.value).join(' / ');
      inputs.forEach((input) => { input.readOnly = true; });
      fillBlankSlots();
    }
    showReveal(currentQuestion.source);
    q('.ydt-feedback').textContent = 'もう一度聞いて、音と文字を結び付けてから次へ進みましょう。';
    const accuracy = settings.mode === 'full' && typed ? L.alignWords(currentQuestion.source, typed).accuracy : 0;
    recordResult(accuracy, false, typed);
    markAnswered();
  }

  function revealOneCharacter() {
    if (!currentQuestion || answered) return;

    if (settings.mode === 'full') {
      const input = q('.ydt-answer-box');
      const answer = currentQuestion.source;
      const typed = input.innerText.replace(/\n/g, ' ');
      let prefix = 0;
      while (prefix < answer.length && prefix < typed.length && answer[prefix].toLowerCase() === typed[prefix].toLowerCase()) prefix += 1;
      // Reveal through the next non-space character so a hint never just adds a space.
      let upto = prefix + 1;
      while (upto < answer.length && answer[upto - 1] === ' ') upto += 1;
      input.textContent = answer.slice(0, upto);
      hintCount += 1;
      focusEditableEnd(input);
    } else {
      const inputs = [...shellEl().querySelectorAll('.ydt-answer')];
      for (let i = 0; i < inputs.length; i += 1) {
        const target = currentQuestion.answers[i];
        const input = inputs[i];
        let prefix = 0;
        while (prefix < input.value.length && prefix < target.length &&
          input.value[prefix].toLowerCase() === target[prefix].toLowerCase()) prefix += 1;
        if (prefix < target.length) {
          input.value = target.slice(0, prefix + 1);
          hintCount += 1;
          input.focus();
          break;
        }
      }
    }

    q('.ydt-feedback').textContent = `ヒント ${hintCount}文字使用`;
  }

  function stopReplay() {
    if (replaySafetyTimer) clearTimeout(replaySafetyTimer);
    replaySafetyTimer = null;
    const video = getVideo();
    if (replaying && video && rateBeforeReplay !== null) video.playbackRate = rateBeforeReplay;
    rateBeforeReplay = null;
    replaying = false;
    q('.ydt-listen')?.classList.remove('playing');
  }

  function replay() {
    const video = getVideo();
    if (!video || !currentQuestion) return;

    stopReplay();
    replaying = true;
    const start = Math.max(0, currentQuestion.startTime - REPLAY_LEAD_SECONDS);
    replayStopAt = Math.max(start + 0.25, currentQuestion.endTime + REPLAY_TAIL_SECONDS);
    const rate = Number(settings.playbackRate) || 1;

    rateBeforeReplay = video.playbackRate;
    video.playbackRate = rate;
    video.currentTime = start;
    q('.ydt-listen')?.classList.add('playing');

    replaySafetyTimer = setTimeout(() => {
      if (awaitingAnswer) video.pause();
      stopReplay();
      focusAnswer();
    }, Math.max(1200, (((replayStopAt - start) / rate) + 1.5) * 1000));

    video.play().catch(() => stopReplay());
    startTicking();
  }

  function focusAnswer() {
    if (answered) return;
    if (settings.mode === 'full') focusEditableEnd(q('.ydt-answer-box'));
    else shellEl()?.querySelector('.ydt-answer:not(.correct)')?.focus();
  }

  function finishQuestion() {
    clearTimeout(autoNextTimer);
    const finished = currentQuestion;
    if (!finished) return;
    awaitingAnswer = false;
    answered = false;
    currentQuestion = null;
    stopReplay();

    const video = getVideo();
    nextUnitIndex = finished.index + 1;
    renderIdle('次の文を聞いてください。');

    if (video) {
      // Resume where the question ended (a replay may have left the playhead elsewhere).
      if (Math.abs(video.currentTime - finished.endTime) > 0.3) video.currentTime = finished.endTime;
      video.play().catch(() => {});
    }
  }

  function goToPreviousUnit() {
    const video = getVideo();
    if (!video || !transcriptUnits.length) return;
    const base = currentQuestion ? currentQuestion.index : nextUnitIndex;
    const target = Math.max(0, base - 1);
    clearTimeout(autoNextTimer);
    awaitingAnswer = false;
    answered = false;
    currentQuestion = null;
    stopReplay();
    nextUnitIndex = target;
    renderIdle('前の文を再生しています…');
    video.currentTime = Math.max(0, transcriptUnits[target].start - REPLAY_LEAD_SECONDS);
    video.play().catch(() => {});
    startTicking();
  }

  // ---- caption loading ----

  async function fetchJson3(baseUrl) {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');
    const response = await fetch(url.toString(), { credentials: 'omit' });
    if (!response.ok) throw new Error(`字幕取得 HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error('字幕本文が空でした');
    return JSON.parse(text);
  }

  function readInnertubeKey() {
    for (const script of document.querySelectorAll('script')) {
      const m = script.textContent.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (m) return m[1];
    }
    return '';
  }

  async function fetchTracksViaInnertube(videoId, client) {
    const key = readInnertubeKey();
    const url = `/youtubei/v1/player?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`;
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { ...client, hl: 'en' } }, videoId })
    });
    if (!response.ok) throw new Error(`player HTTP ${response.status}`);
    const json = await response.json();
    return json?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  async function fetchTracksViaWatchPage() {
    const response = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
    const player = L.extractPlayerResponse(await response.text());
    return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  async function loadCaptionCues(videoId) {
    if (cueCache.has(videoId)) return cueCache.get(videoId);

    const sources = [
      ...INNERTUBE_CLIENTS.map(client => () => fetchTracksViaInnertube(videoId, client)),
      () => fetchTracksViaWatchPage()
    ];
    let lastError = null;
    let sawTracks = false;
    for (const getTracks of sources) {
      try {
        const tracks = await getTracks();
        if (tracks.length) sawTracks = true;
        const picked = L.pickCaptionTrack(tracks);
        if (!picked) continue;
        const cues = L.captionJsonToCues(await fetchJson3(picked.track.baseUrl));
        if (!cues.length) continue;
        const result = {
          cues,
          label: `${picked.name || picked.track.languageCode || 'English'}${picked.track.kind === 'asr' ? '（自動生成）' : ''}`
        };
        cueCache.set(videoId, result);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    if (sawTracks && !lastError) throw new Error('英語字幕トラックが見つかりません');
    throw lastError || new Error('この動画には字幕トラックがありません');
  }

  function rebuildUnits() {
    transcriptUnits = L.cuesToUnits(transcriptCues, UNIT_LENGTHS[settings.unitLength] || UNIT_LENGTHS.normal);
  }

  async function loadTranscript() {
    const videoId = getVideoId();
    if (!settings.enabled || !videoId) return;
    const token = ++transcriptLoadToken;
    transcriptUnits = [];
    transcriptCues = [];
    transcriptVideoId = videoId;
    awaitingAnswer = false;
    currentQuestion = null;
    setSyncStatus('英語字幕のタイムコードを読み込み中…');
    renderIdle('字幕を準備しています…');

    try {
      const { cues, label } = await loadCaptionCues(videoId);
      if (token !== transcriptLoadToken || videoId !== getVideoId()) return;
      transcriptCues = cues;
      rebuildUnits();
      if (!transcriptUnits.length) throw new Error('字幕から練習文を作れませんでした');

      transcriptTrackLabel = label;
      setSyncStatus(`同期済み: ${transcriptTrackLabel} / ${transcriptUnits.length}文`);
      syncNextUnitToCurrentTime(true);
      renderIdle('動画を再生してください。1文ごとに自動停止します。');
      startTicking();
    } catch (error) {
      if (token !== transcriptLoadToken) return;
      transcriptUnits = [];
      setSyncStatus(error?.message || '字幕の読み込みに失敗しました', true);
      renderIdle('この動画では英語字幕を取得できませんでした。');
    }
  }

  function syncNextUnitToCurrentTime(skipPartial = false) {
    const video = getVideo();
    const t = video?.currentTime || 0;
    let index = transcriptUnits.findIndex(unit => (skipPartial ? unit.start >= t - 0.08 : unit.end > t + 0.05));
    if (index < 0) index = transcriptUnits.length;
    nextUnitIndex = index;
  }

  // ---- playback watching ----
  // timeupdate only fires every ~250ms, which lets the first syllables of the next
  // sentence leak through. While playing we also poll on every animation frame.

  function tick() {
    const video = getVideo();
    if (!settings.enabled || !video) return;

    if (replaying) {
      if (!awaitingAnswer || video.currentTime >= replayStopAt) {
        video.pause();
        stopReplay();
        focusAnswer();
      }
      return;
    }
    if (awaitingAnswer || !transcriptUnits.length) return;

    while (nextUnitIndex < transcriptUnits.length && video.currentTime > transcriptUnits[nextUnitIndex].end + 0.9) {
      nextUnitIndex += 1;
    }
    if (nextUnitIndex >= transcriptUnits.length) return;

    const unit = transcriptUnits[nextUnitIndex];
    if (video.currentTime >= unit.end - STOP_EARLY_SECONDS && video.currentTime <= unit.end + 0.9) {
      video.pause();
      const question = buildQuestion(unit, nextUnitIndex);
      if (question) showQuestion(question);
      else {
        nextUnitIndex += 1;
        video.play().catch(() => {});
      }
    }
  }

  function startTicking() {
    if (rafId) return;
    const loop = () => {
      const video = getVideo();
      if (!settings.enabled || !video || video.paused) {
        rafId = 0;
        return;
      }
      tick();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function onVideoSeeked() {
    if (!replaying && !awaitingAnswer) syncNextUnitToCurrentTime(false);
  }

  function attachVideoEvents() {
    const video = getVideo();
    if (!video || video === currentVideo) return;
    if (currentVideo) {
      currentVideo.removeEventListener('timeupdate', tick);
      currentVideo.removeEventListener('seeked', onVideoSeeked);
      currentVideo.removeEventListener('play', startTicking);
    }
    currentVideo = video;
    currentVideo.addEventListener('timeupdate', tick);
    currentVideo.addEventListener('seeked', onVideoSeeked);
    currentVideo.addEventListener('play', startTicking);
  }

  function applySettings(next) {
    const prev = settings;
    settings = { ...defaults, ...next };
    makePanel();
    mountPanel();

    if (!settings.enabled) {
      awaitingAnswer = false;
      currentQuestion = null;
      stopReplay();
      transcriptUnits = [];
      transcriptVideoId = '';
      transcriptLoadToken += 1;
      document.body.classList.remove('ydt-enabled');
      const shell = shellEl();
      if (shell) shell.hidden = true;
      return;
    }

    document.body.classList.add('ydt-enabled');
    const shell = shellEl();
    if (shell) shell.hidden = !panelShouldShow();
    const rateSelect = q('.ydt-rate');
    if (rateSelect) rateSelect.value = String(settings.playbackRate);
    attachVideoEvents();

    if (!prev.enabled || transcriptVideoId !== getVideoId() || !transcriptCues.length) {
      loadTranscript();
      return;
    }

    if (prev.unitLength !== settings.unitLength) {
      const keepTime = currentQuestion ? currentQuestion.startTime : null;
      rebuildUnits();
      setSyncStatus(`同期済み: ${transcriptTrackLabel} / ${transcriptUnits.length}文`);
      if (awaitingAnswer && keepTime !== null) {
        const idx = transcriptUnits.findIndex(unit => unit.end > keepTime + 0.05);
        if (idx >= 0) showQuestion(buildQuestion(transcriptUnits[idx], idx));
      } else {
        syncNextUnitToCurrentTime(false);
      }
      return;
    }

    // Mode or difficulty changed mid-question: rebuild the current question in place.
    const questionShape = ['mode', 'difficulty', 'blankCount'];
    if (awaitingAnswer && !answered && currentQuestion && questionShape.some(k => prev[k] !== settings[k])) {
      const unit = transcriptUnits[currentQuestion.index];
      const rebuilt = unit && buildQuestion(unit, currentQuestion.index);
      if (rebuilt) showQuestion(rebuilt);
    }
  }

  chrome.storage.sync.get(defaults, applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
    applySettings(next);
  });

  function onNavigation() {
    makePanel();
    mountPanel();
    attachVideoEvents();
    if (!getVideoId() && currentQuestion) {
      // Left the watch page mid-question.
      awaitingAnswer = false;
      answered = false;
      currentQuestion = null;
      stopReplay();
    }
    const shell = shellEl();
    if (shell && !currentQuestion) shell.hidden = !panelShouldShow();
    if (settings.enabled && getVideoId() && transcriptVideoId !== getVideoId()) loadTranscript();
  }

  document.addEventListener('yt-navigate-finish', () => setTimeout(onNavigation, 350));
  setInterval(onNavigation, 1000);

  makePanel();
  attachVideoEvents();
})();
