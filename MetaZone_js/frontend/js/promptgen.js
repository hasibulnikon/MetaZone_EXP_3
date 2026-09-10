// Image to Prompt Generator page (v0.8.6) -- structurally a copy of
// app.js's Meta Generator wiring, simplified: a single "Prompt" card
// field instead of Title/Description/Keywords, no platform/file-type/
// prefix-suffix logic. Talks to bridge.py's prompt_* methods, which
// are thin wrappers around a completely separate Session instance
// (self.prompt_session, event_prefix="prompt_") -- see bridge.py.
// This file only exists on page-prompt; its DOM ids never collide
// with app.js's Meta Generator ids (both pages are in the DOM at
// once, see index.html).

const statusTextPrompt = document.getElementById('statusPrompt');
const statusModelTextPrompt = document.getElementById('statusModelPrompt');
const progressWrapPrompt = document.getElementById('progressWrapPrompt');
const progressBarPrompt = document.getElementById('progressBarPrompt');
const cardGridPrompt = document.getElementById('cardGridPrompt');
const emptyStatePrompt = document.getElementById('emptyStatePrompt');
const genCountElPrompt = document.getElementById('genCountPrompt');
const cardTemplatePrompt = document.getElementById('cardTemplatePrompt');
const dropzonePrompt = document.getElementById('dropzonePrompt');
const dropzoneTextPrompt = document.getElementById('dropzoneTextPrompt');
const importGridPrompt = document.getElementById('importGridPrompt');

const cardElsPrompt = new Map();
const lastAppliedPrompt = new Map();
let totalImportedPrompt = 0;
let importedPathsPrompt = [];
const GRID_SLOTS_PROMPT = 30;
const thumbCachePrompt = new Map();

function updateEmptyStatePrompt() {
  emptyStatePrompt.classList.toggle('visible', cardElsPrompt.size === 0);
}

function statusLabelPrompt(status) {
  return { waiting: '○ Waiting', working: '⟳ Working…', done: '✓ Done',
           failed: '✗ Failed', stopped: '■ Stopped' }[status] || status;
}

function setThumbPrompt(el, b64) {
  const holder = el.querySelector('.card-thumb');
  holder.innerHTML = `<img src="data:image/jpeg;base64,${b64}">`;
}

// v0.9.3: same per-card file-info line as app.js's Meta Generator
// cards -- see that file for the formatFileSize/setFileInfo notes;
// this page just needs its own cache and reuses the shared helpers
// (formatFileSize is defined once, in app.js, which loads first).
const fileMetaCachePrompt = new Map();
function setFileInfoPrompt(el, path, meta) {
  const nameEl = el.querySelector('.card-file-name');
  const dimsEl = el.querySelector('.card-file-dims');
  const sizeEl = el.querySelector('.card-file-size');
  if (nameEl) { nameEl.textContent = path.split(/[\\/]/).pop() || ''; nameEl.title = path; }
  if (dimsEl) dimsEl.textContent = (meta && meta.width && meta.height) ? `${meta.width}×${meta.height}` : '';
  if (sizeEl) sizeEl.textContent = meta ? formatFileSize(meta.size_bytes) : '';
}

function renderImportGridPrompt() {
  dropzonePrompt.classList.toggle('clickable', importedPathsPrompt.length === 0);
  if (importedPathsPrompt.length === 0) {
    importGridPrompt.hidden = true;
    dropzoneTextPrompt.hidden = false;
    return;
  }
  dropzoneTextPrompt.hidden = true;
  importGridPrompt.hidden = false;
  const overflow = importedPathsPrompt.length > GRID_SLOTS_PROMPT;
  const shown = overflow ? importedPathsPrompt.slice(0, GRID_SLOTS_PROMPT - 1) : importedPathsPrompt.slice(0, GRID_SLOTS_PROMPT);
  let html = shown.map(p => {
    const thumb = thumbCachePrompt.get(p);
    return `<div class="import-cell">${thumb ? `<img src="data:image/jpeg;base64,${thumb}">` : ''}</div>`;
  }).join('');
  if (overflow) {
    html += `<div class="import-cell import-cell-more">+${importedPathsPrompt.length - shown.length}</div>`;
  }
  importGridPrompt.innerHTML = html;
}

function countWordsPrompt(text) { return (text || '').trim() ? text.trim().split(/\s+/).length : 0; }

function refreshCardCountsPrompt(el, result) {
  el.querySelector('.card-prompt-count').textContent = result.prompt ? `${countWordsPrompt(result.prompt)} words` : '';
}

function applyCardPrompt(path, result) {
  const key = JSON.stringify(result);
  if (lastAppliedPrompt.get(path) === key) return;

  let el = cardElsPrompt.get(path);
  const isNew = !el;
  if (isNew) {
    if (result.status !== 'done' && result.status !== 'failed') {
      lastAppliedPrompt.set(path, key);
      return;
    }
    el = cardTemplatePrompt.content.firstElementChild.cloneNode(true);
    el.dataset.path = path;
    cardGridPrompt.appendChild(el);
    cardElsPrompt.set(path, el);
    Animate.popIn(el);
    const cached = thumbCachePrompt.get(path);
    if (cached) setThumbPrompt(el, cached);
    setFileInfoPrompt(el, path, fileMetaCachePrompt.get(path));
  } else {
    Animate.flash(el, 'updated-flash');
  }

  const statusEl = el.querySelector('.card-status');
  statusEl.textContent = statusLabelPrompt(result.status);
  statusEl.className = 'card-status ' + (result.status || '');
  el.querySelector('.card-prompt').textContent = result.prompt || (result.error ? `Error: ${result.error}` : '—');
  el.querySelector('.card-model').textContent = result.model_used || '';
  refreshCardCountsPrompt(el, result);

  const regenBtn = el.querySelector('.card-regen-btn');
  if (regenBtn && (result.status === 'done' || result.status === 'failed')) {
    regenBtn.disabled = false;
    regenBtn.classList.remove('spinning');
  }

  lastAppliedPrompt.set(path, key);
  updateEmptyStatePrompt();
  document.getElementById('gridCountPrompt').textContent = cardElsPrompt.size;
}

function fieldElAndKeyPrompt(fieldRow) {
  const key = fieldRow.dataset.field; // 'prompt'
  const textEl = fieldRow.querySelector('.field-text');
  return { key, textEl };
}

async function pushFieldUpdatePrompt(path, field, value) {
  try { await pywebview.api.update_prompt_card_field(path, field, value); } catch (e) { /* best effort */ }
}

cardGridPrompt.addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const path = card.dataset.path;

  const regenBtn = e.target.closest('.card-regen-btn');
  if (regenBtn) {
    if (regenBtn.disabled) return;
    regenBtn.disabled = true;
    regenBtn.classList.add('spinning');
    const res = await pywebview.api.regenerate_prompt_card(path, buildPromptGenOptions());
    if (!res.ok) {
      regenBtn.disabled = false;
      regenBtn.classList.remove('spinning');
      statusTextPrompt.textContent = res.error || 'Could not regenerate this card.';
    }
    return;
  }

  const deleteBtn = e.target.closest('.card-delete-btn');
  if (deleteBtn) {
    const res = await pywebview.api.delete_prompt_card(path);
    if (!res.ok) { statusTextPrompt.textContent = res.error || 'Could not delete this card.'; return; }
    return;
  }

  const copyBtn = e.target.closest('.field-copy-btn');
  if (copyBtn) {
    const { textEl } = fieldElAndKeyPrompt(copyBtn.closest('.card-field'));
    await copyText(textEl.textContent);
    flashCopied(copyBtn);
    return;
  }

  const pasteBtn = e.target.closest('.field-paste-btn');
  if (pasteBtn) {
    const { key, textEl } = fieldElAndKeyPrompt(pasteBtn.closest('.card-field'));
    let pasted = '';
    try { pasted = await navigator.clipboard.readText(); } catch (e2) { return; }
    if (!pasted) return;
    textEl.textContent = pasted;
    refreshCardCountsPrompt(card, { prompt: pasted });
    await pushFieldUpdatePrompt(path, key, pasted);
    return;
  }

  const editBtn = e.target.closest('.card-edit-btn');
  if (editBtn) {
    const nowEditing = !card.classList.contains('editing');
    card.classList.toggle('editing', nowEditing);
    card.querySelectorAll('.field-text').forEach(f => f.setAttribute('contenteditable', nowEditing ? 'true' : 'false'));
    editBtn.textContent = nowEditing ? '✓' : '✎';
    editBtn.title = nowEditing ? 'Done editing' : 'Edit this card';
    if (!nowEditing) {
      const promptText = card.querySelector('.card-prompt').textContent;
      refreshCardCountsPrompt(card, { prompt: promptText });
      await pushFieldUpdatePrompt(path, 'prompt', promptText);
    }
  }
});

cardGridPrompt.addEventListener('input', (e) => {
  const fieldText = e.target.closest('.field-text');
  if (!fieldText || fieldText.getAttribute('contenteditable') !== 'true') return;
  const card = fieldText.closest('.card');
  refreshCardCountsPrompt(card, { prompt: card.querySelector('.card-prompt').textContent });
});

BackendEvents.on('prompt_thumb_ready', (p) => {
  thumbCachePrompt.set(p.path, p.thumb);
  const el = cardElsPrompt.get(p.path);
  if (el) setThumbPrompt(el, p.thumb);
  if (importedPathsPrompt.includes(p.path)) renderImportGridPrompt();
});

BackendEvents.on('prompt_file_meta_ready', (p) => {
  fileMetaCachePrompt.set(p.path, p.meta);
  const el = cardElsPrompt.get(p.path);
  if (el) setFileInfoPrompt(el, p.path, p.meta);
});

BackendEvents.on('prompt_card_update', (p) => applyCardPrompt(p.path, p.result));

// v0.8.9: mirrors app.js's card_removed handler against this page's
// own event_prefix ("prompt_") -- see Session.delete_card().
BackendEvents.on('prompt_card_removed', (p) => {
  const el = cardElsPrompt.get(p.path);
  if (el) {
    Animate.fadeOut(el, () => el.remove());
  }
  cardElsPrompt.delete(p.path);
  lastAppliedPrompt.delete(p.path);
  thumbCachePrompt.delete(p.path);
  updateEmptyStatePrompt();
  document.getElementById('gridCountPrompt').textContent = cardElsPrompt.size;
});

BackendEvents.on('prompt_task_progress', (p) => {
  progressWrapPrompt.style.display = 'block';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  progressBarPrompt.style.width = pct + '%';
  statusTextPrompt.textContent = p.msg || `Processing ${p.done}/${p.total}`;
});

BackendEvents.on('prompt_status_text', (p) => { statusModelTextPrompt.textContent = p.msg; });

BackendEvents.on('prompt_task_completed', (p) => {
  statusTextPrompt.textContent = `Done — ${p.total} images processed`;
  statusModelTextPrompt.textContent = '';
  setGeneratingStatePrompt(false);
});

function setGeneratingStatePrompt(running) {
  document.getElementById('btnGeneratePrompt').disabled = running;
  document.getElementById('btnPausePrompt').disabled = !running;
  document.getElementById('btnStopPrompt').disabled = !running;
}

async function doBrowsePromptImages() {
  statusTextPrompt.textContent = 'Opening file picker…';
  const res = await pywebview.api.browse_prompt_images();
  if (!res.ok) { statusTextPrompt.textContent = 'Could not open file picker.'; return; }
  totalImportedPrompt += res.accepted.length;
  genCountElPrompt.textContent = totalImportedPrompt;
  importedPathsPrompt.push(...res.accepted);
  renderImportGridPrompt();
  statusTextPrompt.textContent = '';
  Toast.showImportSummary(res.accepted, res.rejected);
  // v0.9.3 parity fix: app.js's dropzone plays a green "drop success"
  // pulse (Animate.dropSuccess) after a real import; this page's
  // dropzone never got that call, so a successful drag-and-drop here
  // had no visual confirmation at all beyond the status text -- easy
  // to read as "drag-and-drop isn't working" even though the import
  // itself succeeded.
  if (res.accepted.length) Animate.dropSuccess(dropzonePrompt);
}

document.getElementById('btnBrowsePrompt').addEventListener('click', doBrowsePromptImages);

dropzonePrompt.addEventListener('click', () => {
  if (importedPathsPrompt.length === 0) doBrowsePromptImages();
});

// v0.9.3: same dropEffect fix as app.js's dropzone -- see that file
// for the full root-cause note.
['dragenter', 'dragover'].forEach(evt =>
  dropzonePrompt.addEventListener(evt, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropzonePrompt.classList.add('drag-active');
  })
);
['dragleave', 'drop'].forEach(evt =>
  dropzonePrompt.addEventListener(evt, (e) => { e.preventDefault(); dropzonePrompt.classList.remove('drag-active'); })
);

// Real filesystem-path drag/drop for this page is not wired (same
// known-open item app.js's Meta Generator flags for its own dropzone
// -- see README) -- only the visual drag-active state above is real
// right now, matching that same honestly-flagged limitation.
BackendEvents.on('prompt_import_completed', (res) => {
  totalImportedPrompt += res.accepted.length;
  genCountElPrompt.textContent = totalImportedPrompt;
  importedPathsPrompt.push(...res.accepted);
  renderImportGridPrompt();
  Toast.showImportSummary(res.accepted, res.rejected);
  // Same drop-success pulse fix as doBrowsePromptImages above, for the
  // real drag-and-drop path (routed from app.py's _bind_real_drag_drop).
  if (res.accepted.length) Animate.dropSuccess(dropzonePrompt);
});

document.getElementById('btnGeneratePrompt').addEventListener('click', async () => {
  const options = buildPromptGenOptions();
  statusTextPrompt.textContent = 'Starting…';
  statusModelTextPrompt.textContent = '';
  setGeneratingStatePrompt(true);
  const res = await pywebview.api.start_prompt_generation(options);
  if (!res.ok) {
    statusTextPrompt.textContent = res.error || 'Could not start generation.';
    setGeneratingStatePrompt(false);
  } else {
    statusTextPrompt.textContent = `Generating ${res.total} prompt(s)…`;
  }
});

// Extracted (v0.8.9) so both the Generate button above and a single
// card's Regenerate button (in cardGridPrompt's click handler) build
// options from the exact same on-screen control-panel state.
function buildPromptGenOptions() {
  const styleSel = document.getElementById('optPromptStyle');
  return {
    max_words: parseInt(document.getElementById('optMaxPromptWords').value) || 60,
    concurrency: parseInt(document.getElementById('optConcurrencyPrompt').value) || 10,
    custom: document.getElementById('optCustomPromptGen').value,
    content_phrase: promptStylesCache[styleSel.value] || '',
    auto_download_csv: false,
  };
}

document.getElementById('btnPausePrompt').addEventListener('click', async () => {
  const res = await pywebview.api.pause_prompt_generation();
  document.getElementById('btnPausePrompt').textContent = res.paused ? '▶ Resume' : '⏸ Pause';
});

document.getElementById('btnStopPrompt').addEventListener('click', async () => {
  await pywebview.api.stop_prompt_generation();
  setGeneratingStatePrompt(false);
  statusTextPrompt.textContent = 'Stopped.';
  statusModelTextPrompt.textContent = '';
});

document.getElementById('btnClearPrompt').addEventListener('click', async () => {
  await pywebview.api.clear_prompt_batch();
  cardGridPrompt.innerHTML = '';
  cardElsPrompt.clear();
  lastAppliedPrompt.clear();
  thumbCachePrompt.clear();
  totalImportedPrompt = 0;
  importedPathsPrompt = [];
  renderImportGridPrompt();
  genCountElPrompt.textContent = '0';
  progressWrapPrompt.style.display = 'none';
  statusTextPrompt.textContent = 'Batch cleared.';
  statusModelTextPrompt.textContent = '';
  updateEmptyStatePrompt();
});

// "Export CSV" -- manual download, same shared _export_csv_session
// helper bridge.py's Meta Generator "⬇ Download CSV" button uses,
// just against self.prompt_session instead of self.session.
document.getElementById('btnExportCsvPrompt').addEventListener('click', async () => {
  const res = await pywebview.api.export_prompt_csv(false);
  if (res.cancelled) return;
  statusTextPrompt.textContent = res.ok ? `CSV saved: ${res.path}` : (res.error || 'Could not export CSV.');
});

// "💾 Save" -- per Hasib's screenshot 3 reference for this header
// row's button set, with no separate spec for what it does beyond
// matching that layout. Interpreted here as: push whatever's
// currently on screen for every card back to the backend (covers any
// edits left mid-type without leaving edit mode via the pencil icon),
// then confirm. Flagged as an assumption, not a confirmed spec, in
// CHANGELOG.md -- revisit if Hasib means something else by it.
document.getElementById('btnSavePrompt').addEventListener('click', async () => {
  const cards = cardGridPrompt.querySelectorAll('.card');
  let n = 0;
  for (const card of cards) {
    const path = card.dataset.path;
    const promptText = card.querySelector('.card-prompt').textContent;
    await pushFieldUpdatePrompt(path, 'prompt', promptText);
    n++;
  }
  statusTextPrompt.textContent = n ? `Saved ${n} prompt(s).` : 'Nothing to save yet.';
});

// ---- Control panel: key summary, concurrency pref, style dropdown ----
async function refreshKeySummaryPrompt() {
  const res = await pywebview.api.get_active_keys_summary();
  const el = document.getElementById('keySummaryPrompt');
  el.innerHTML = `
    <div class="key-summary-item"><strong>${res.active_count}</strong>Active</div>
    <div class="key-summary-item"><strong>${res.stored_count}</strong>Stored</div>
    <div class="key-summary-item"><strong>${res.provider_count}</strong>Providers</div>`;
}
document.getElementById('btnCheckKeysPrompt').addEventListener('click', async (e) => {
  e.stopPropagation();
  const res = await pywebview.api.get_active_keys_summary();
  statusTextPrompt.textContent = res.active_count
    ? `Active keys: ${res.active_count} (${res.providers.join(', ')})`
    : 'No active API keys configured — open Settings.';
});

// v0.9.5.1: same click-to-navigate restoration as app.js's Meta page.
[document.getElementById('apiInfoNavPrompt'), document.getElementById('keySummaryPrompt')].forEach((el) => {
  el.addEventListener('click', () => goToPage('settings'));
});

let promptStylesCache = {};
async function loadPromptOptions() {
  const res = await pywebview.api.get_prompt_options();
  if (!res.ok) return;
  promptStylesCache = res.styles;
  const sel = document.getElementById('optPromptStyle');
  sel.innerHTML = Object.keys(promptStylesCache).map(s => `<option>${s}</option>`).join('');
}

const optConcurrencyPromptEl = document.getElementById('optConcurrencyPrompt');
async function loadConcurrencyPrefPrompt() {
  const res = await pywebview.api.get_prefs();
  const saved = res.ok ? res.prefs.prompt_concurrency : null;
  const value = (saved && saved >= 1 && saved <= 20) ? saved : 10;
  optConcurrencyPromptEl.value = value;
  document.getElementById('concurrencyValPrompt').textContent = value + 'x';
}
optConcurrencyPromptEl.addEventListener('change', () => {
  pywebview.api.save_prefs({ prompt_concurrency: parseInt(optConcurrencyPromptEl.value) || 10 });
});

// Max Prompt Words switched from a free-drag 10-500 slider to a fixed
// dropdown (50/100/200/300/500/1000) -- the select's own displayed
// option is the value, so no separate live-updating "…Val" label is
// needed the way the old slider required.
const optMaxPromptWordsEl = document.getElementById('optMaxPromptWords');

const DEFAULT_PROMPT_SYSTEM = '';
document.getElementById('btnResetDefaultsPrompt').addEventListener('click', () => {
  document.getElementById('optCustomPromptGen').value = DEFAULT_PROMPT_SYSTEM;
});

document.getElementById('btnCollapsePanelPrompt').addEventListener('click', () => {
  const panel = document.getElementById('controlPanelPrompt');
  const btn = document.getElementById('btnCollapsePanelPrompt');
  const collapsed = panel.classList.toggle('collapsed');
  // v0.9.3.1: rotate the same chevron icon 180deg instead of swapping
  // "<"/">" glyphs -- see .panel-collapse-btn.collapsed in base.css.
  btn.classList.toggle('collapsed', collapsed);
  btn.title = collapsed ? 'Show panel' : 'Hide panel';
});

// v0.9.3 (same engine as app.js's Meta Generator "View" dropdown --
// see base.css's .view-select/.card-grid[data-cols] rules, shared by
// both pages): 2/3/4-column card grid for cardGridPrompt, persisted
// via the same get_prefs/save_prefs merge under its own key so it
// doesn't collide with Meta Generator's saved column count.
const viewSelectPrompt = document.getElementById('viewSelectPrompt');
const btnViewSelectPrompt = document.getElementById('btnViewSelectPrompt');
const viewSelectMenuPrompt = document.getElementById('viewSelectMenuPrompt');

btnViewSelectPrompt.addEventListener('click', (e) => {
  e.stopPropagation();
  viewSelectPrompt.classList.toggle('open');
  btnViewSelectPrompt.setAttribute('aria-expanded', viewSelectPrompt.classList.contains('open') ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
  if (viewSelectPrompt.classList.contains('open') && !viewSelectPrompt.contains(e.target)) {
    viewSelectPrompt.classList.remove('open');
    btnViewSelectPrompt.setAttribute('aria-expanded', 'false');
  }
});

function setCardColumnsPrompt(cols, { fade = true } = {}) {
  viewSelectMenuPrompt.querySelectorAll('.view-select-option').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.cols) === cols);
  });
  const apply = () => { cardGridPrompt.dataset.cols = String(cols); };
  if (!fade) { apply(); return; }
  cardGridPrompt.classList.add('view-fading');
  setTimeout(() => {
    apply();
    void cardGridPrompt.offsetWidth;
    cardGridPrompt.classList.remove('view-fading');
  }, 180);
}

viewSelectMenuPrompt.querySelectorAll('.view-select-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    const cols = parseInt(btn.dataset.cols) || 3;
    setCardColumnsPrompt(cols);
    viewSelectPrompt.classList.remove('open');
    btnViewSelectPrompt.setAttribute('aria-expanded', 'false');
    await pywebview.api.save_prefs({ prompt_card_columns: cols });
  });
});

async function loadCardColumnsPrefPrompt() {
  const res = await pywebview.api.get_prefs();
  const saved = res.ok ? res.prefs.prompt_card_columns : null;
  const cols = [2, 3, 4].includes(saved) ? saved : 3;
  setCardColumnsPrompt(cols, { fade: false });
}

onPywebviewReady(() => {
  loadPromptOptions();
  refreshKeySummaryPrompt();
  loadConcurrencyPrefPrompt();
  loadCardColumnsPrefPrompt();
});
