const defaults = {
  enabled: false,
  mode: 'full',
  difficulty: 'normal',
  blankCount: 2,
  autoResume: false,
  playbackRate: 1.0
};

const enabled = document.getElementById('enabled');
const mode = document.getElementById('mode');
const difficulty = document.getElementById('difficulty');
const blankCount = document.getElementById('blankCount');
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
    playbackRate: Number(playbackRate.value),
    autoResume: autoResume.checked
  });
  refreshVisibility();
}

[enabled, mode, difficulty, blankCount, playbackRate, autoResume].forEach((el) => {
  el.addEventListener('change', save);
});
