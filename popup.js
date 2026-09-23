const defaults = {
  enabled: false,
  mode: 'full',
  difficulty: 'normal',
  blankCount: 2,
  autoResume: false,
  playbackRate: 1.0,
  unitLength: 'normal'
};

const enabled = document.getElementById('enabled');
const mode = document.getElementById('mode');
const difficulty = document.getElementById('difficulty');
const blankCount = document.getElementById('blankCount');
const unitLength = document.getElementById('unitLength');
const playbackRate = document.getElementById('playbackRate');
const autoResume = document.getElementById('autoResume');
const blankCountRow = document.getElementById('blankCountRow');

function refreshVisibility() {
  blankCountRow.style.display = mode.value === 'blanks' ? 'flex' : 'none';
  difficulty.parentElement.style.display = mode.value === 'full' ? 'none' : 'flex';
}

chrome.storage.sync.get(defaults, (settings) => {
  enabled.checked = settings.enabled;
  mode.value = settings.mode;
  difficulty.value = settings.difficulty;
  blankCount.value = String(settings.blankCount);
  unitLength.value = settings.unitLength;
  playbackRate.value = String(settings.playbackRate);
  autoResume.checked = settings.autoResume;
  refreshVisibility();
});

function save() {
  chrome.storage.sync.set({
    enabled: enabled.checked,
    mode: mode.value,
    difficulty: difficulty.value,
    blankCount: Number(blankCount.value),
    unitLength: unitLength.value,
    playbackRate: Number(playbackRate.value),
    autoResume: autoResume.checked
  });
  refreshVisibility();
}

[enabled, mode, difficulty, blankCount, unitLength, playbackRate, autoResume].forEach((el) => {
  el.addEventListener('change', save);
});

// ---- review list ----

const mistakesEl = document.getElementById('mistakes');
const emptyEl = document.getElementById('empty');
const totalsEl = document.getElementById('totals');
const clearEl = document.getElementById('clear');

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderReview({ ydtHistory, ydtMistakes }) {
  totalsEl.textContent = ydtHistory.total
    ? `累計 ${ydtHistory.correct} / ${ydtHistory.total} 正解 (${Math.round((ydtHistory.correct / ydtHistory.total) * 100)}%)`
    : '';
  mistakesEl.replaceChildren();
  for (const m of ydtMistakes.slice(0, 50)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(m.videoId)}&t=${Math.max(0, Math.floor(m.start) - 1)}s`;
    a.target = '_blank';
    a.title = '動画のこの位置を開く';
    const sentence = document.createElement('span');
    sentence.className = 'sentence';
    sentence.textContent = m.sentence;
    a.appendChild(sentence);
    if (m.typed) {
      const typed = document.createElement('span');
      typed.className = 'typed';
      typed.textContent = `あなた: ${m.typed}`;
      a.appendChild(typed);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${m.accuracy}% · ${formatTime(m.start)} · ${m.title || m.videoId}`;
    a.appendChild(meta);
    li.appendChild(a);
    mistakesEl.appendChild(li);
  }
  emptyEl.hidden = ydtMistakes.length > 0;
  clearEl.hidden = !ydtMistakes.length && !ydtHistory.total;
}

function loadReview() {
  chrome.storage.local.get({ ydtHistory: { total: 0, correct: 0 }, ydtMistakes: [] }, renderReview);
}

clearEl.addEventListener('click', () => {
  if (!confirm('累計成績と復習リストを消去しますか？')) return;
  chrome.storage.local.remove(['ydtHistory', 'ydtMistakes'], loadReview);
});

loadReview();
