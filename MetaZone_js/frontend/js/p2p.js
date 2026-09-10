// Prompt-to-Prompt Generator page (v0.8.7 rebuild) -- two modes sharing
// one control panel and one results panel: "From Text" (original
// behavior: one prompt in, N variations out) and "From Image" (up to
// 15 reference images in, N prompts inspired by them out). Both talk
// to the same bridge.start_prompt_to_prompt(); the useImage flag picks
// which the backend's PromptToPromptSession actually runs.

const p2pTextPane = document.getElementById('p2pTextPane');
const p2pImagePane = document.getElementById('p2pImagePane');
const p2pOriginal = document.getElementById('p2pOriginal');
const p2pOriginalWordCount = document.getElementById('p2pOriginalWordCount');
const p2pImageGrid = document.getElementById('p2pImageGrid');
const p2pCountInput = document.getElementById('p2pCount');
const p2pCreativityInput = document.getElementById('p2pCreativity');
const p2pStyleSel = document.getElementById('p2pStyle');
const p2pLength = document.getElementById('p2pLength');
const p2pConcurrency = document.getElementById('p2pConcurrency');
const p2pConcurrencyVal = document.getElementById('p2pConcurrencyVal');
const btnP2pStart = document.getElementById('btnP2pStart');
const btnP2pPause = document.getElementById('btnP2pPause');
const btnP2pStop = document.getElementById('btnP2pStop');
const p2pProgressWrap = document.getElementById('p2pProgressWrap');
const p2pProgressBar = document.getElementById('p2pProgressBar');
const p2pStatus = document.getElementById('p2pStatus');
const p2pResults = document.getElementById('p2pResults');
const p2pResultsCount = document.getElementById('p2pResultsCount');

const P2P_IMAGE_SLOTS = 15;
let p2pUseImage = false;
let p2pImages = [];           // paths, mirrors backend P2PImageStore
const p2pThumbCache = new Map();
let p2pPrompts = [];          // current result list (strings)
let p2pSelectAllOn = false;

// ---- Tab switching (From Text / From Image) ----
document.querySelectorAll('[data-p2p-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-p2p-tab]').forEach(b => b.classList.toggle('active', b === btn));
    p2pUseImage = btn.dataset.p2pTab === 'image';
    p2pTextPane.style.display = p2pUseImage ? 'none' : '';
    p2pImagePane.style.display = p2pUseImage ? '' : 'none';
  });
});

// ---- Count / Creativity / Prompt-Length segmented buttons ----
function wireChoiceRow(rowId, hiddenInput) {
  document.querySelectorAll(`#${rowId} .p2p-choice-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(`#${rowId} .p2p-choice-btn`).forEach(b => b.classList.toggle('active', b === btn));
      hiddenInput.value = btn.dataset.count || btn.dataset.creativity || btn.dataset.length;
    });
  });
}
wireChoiceRow('p2pCountRow', p2pCountInput);
wireChoiceRow('p2pCreativityRow', p2pCreativityInput);
// v0.9.3: Prompt Length switched from a free-drag 10-500 slider to a
// fixed-choice button row (50/100/200/300/400/500), same pattern and
// styling as the Generate count row above, per Hasib's request.
wireChoiceRow('p2pLengthRow', p2pLength);

// v0.9.3: Concurrency moved out of a plain number input at the bottom
// of the panel into a proper slider (1-20) between Prompt Length and
// the Generate button, styled identically to the old Prompt Length
// slider (.control-slider-row + .range-input) it replaced.
p2pConcurrency.addEventListener('input', () => {
  p2pConcurrencyVal.textContent = `${p2pConcurrency.value}x`;
});

p2pOriginal.addEventListener('input', () => {
  const n = p2pOriginal.value.trim() ? p2pOriginal.value.trim().split(/\s+/).length : 0;
  p2pOriginalWordCount.textContent = `${n} words`;
});

// ---- "From Image" 15-slot reference grid ----
function renderP2pImageGrid() {
  let html = '';
  for (let i = 0; i < P2P_IMAGE_SLOTS; i++) {
    const path = p2pImages[i];
    if (path) {
      const thumb = p2pThumbCache.get(path);
      html += `<div class="p2p-image-slot filled" data-path="${i}">
        ${thumb ? `<img src="data:image/jpeg;base64,${thumb}">` : ''}
        <button type="button" class="p2p-slot-remove" data-remove="${i}">✕</button>
      </div>`;
    } else {
      html += `<div class="p2p-image-slot" data-add="1">+</div>`;
    }
  }
  p2pImageGrid.innerHTML = html;
}
renderP2pImageGrid();

p2pImageGrid.addEventListener('click', async (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    const idx = parseInt(removeBtn.dataset.remove);
    const path = p2pImages[idx];
    if (!path) return;
    const res = await pywebview.api.remove_p2p_image(path);
    if (res.ok) { p2pImages = res.paths; renderP2pImageGrid(); }
    return;
  }
  const addSlot = e.target.closest('[data-add]');
  if (addSlot) {
    if (p2pImages.length >= P2P_IMAGE_SLOTS) return;
    p2pStatus.textContent = 'Opening file picker…';
    const res = await pywebview.api.browse_p2p_images();
    if (!res.ok) { p2pStatus.textContent = 'Could not open file picker.'; return; }
    p2pImages = res.paths || p2pImages;
    renderP2pImageGrid();
    p2pStatus.textContent = res.rejected && res.rejected.length
      ? `Added ${res.accepted.length}, rejected ${res.rejected.length}.`
      : (res.accepted && res.accepted.length ? `Added ${res.accepted.length} image(s).` : 'Ready.');
  }
});

BackendEvents.on('p2p_image_thumb', (p) => {
  p2pThumbCache.set(p.path, p.thumb);
  if (p2pImages.includes(p.path)) renderP2pImageGrid();
});

// Real filesystem drag-and-drop onto the image grid is bound on the
// Python side (app.py's element-scoped DOM drop handler, matching the
// existing pywebviewFullPath pattern) -- this is just the visual
// drag-active affordance.
// v0.9.3: same dropEffect fix as app.js's dropzone -- see that file
// for the full root-cause note (preventDefault alone isn't enough for
// Chromium/WebView2 to show the "copy" cursor instead of "blocked").
['dragenter', 'dragover'].forEach(evt =>
  p2pImageGrid.addEventListener(evt, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    p2pImageGrid.classList.add('drag-active');
  })
);
['dragleave', 'drop'].forEach(evt =>
  p2pImageGrid.addEventListener(evt, (e) => { e.preventDefault(); p2pImageGrid.classList.remove('drag-active'); })
);
BackendEvents.on('p2p_images_dropped', (res) => {
  p2pImages = res.paths || p2pImages;
  renderP2pImageGrid();
  p2pStatus.textContent = res.rejected && res.rejected.length
    ? `Dropped: added ${res.accepted.length}, rejected ${res.rejected.length}.`
    : `Dropped: added ${(res.accepted || []).length} image(s).`;
});

async function refreshP2pImages() {
  const res = await pywebview.api.get_p2p_images();
  if (res.ok) { p2pImages = res.paths; renderP2pImageGrid(); }
}

// ---- Results rendering: card grid (v0.8.9) -- previously a flat
// stacked list of rows; now matches the Metadata Generator's card-grid
// look, with each prompt's word count shown top-right on its own card
// and a per-card delete button (bottom-right, same placement as the
// metadata/prompt-gen cards' edit button) so a single unwanted result
// can be removed without discarding the whole batch. Deletion is
// purely client-side -- p2pPrompts is just an in-memory array with no
// backend-side per-item state (P2P has no per-file card/session
// concept, see prompt2prompt.py), so splicing it here and re-rendering
// is the complete, correct removal.
function countWordsP2p(text) { return (text || '').trim() ? text.trim().split(/\s+/).length : 0; }

const P2P_TRASH_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>`;
// Same copy-icon glyph as the Metadata Generator cards' field-copy-btn,
// reused here so the two pages look consistent per Hasib's request.
const P2P_COPY_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>`;

function cardHtmlP2p(p, i) {
  return `
    <div class="p2p-card pop-in">
      <div class="p2p-card-top">
        <label class="p2p-card-select">
          <input type="checkbox" class="p2p-check" data-idx="${i}">
          #${i + 1}
        </label>
        <button type="button" class="icon-btn p2p-card-copy" data-copy="${i}" title="Copy this prompt">${P2P_COPY_SVG}</button>
        <span class="p2p-card-wordcount">${countWordsP2p(p)} words</span>
      </div>
      <div class="p2p-card-text" data-idx="${i}">${p.replace(/</g, '&lt;')}</div>
      <button type="button" class="p2p-card-edit" data-edit="${i}" title="Edit this prompt">✎</button>
      <button type="button" class="p2p-card-delete" data-delete="${i}" title="Delete this prompt">${P2P_TRASH_SVG}</button>
    </div>`;
}

function renderP2pResults() {
  p2pResultsCount.textContent = `Generated Prompts (${p2pPrompts.length})`;
  if (!p2pPrompts.length) {
    p2pResults.innerHTML = '<p class="p2p-empty-hint">Generated prompts will appear here.</p>';
    return;
  }
  p2pResults.innerHTML = p2pPrompts.map(cardHtmlP2p).join('');
}
renderP2pResults();

// v0.9.x (Part 15): p2p_partial/p2p_completed used to call renderP2pResults()
// directly, which rebuilds the entire results container from scratch on
// every delivery -- 5 prompts -> render 5, 10 prompts -> destroy 5 + create
// 10, 15 -> destroy 10 + create 15. This is the incremental path: when the
// new list is a pure append onto what's already on screen, only the new
// cards are created and appended, so already-settled cards (and any
// checkbox the user already ticked) are left alone. Any non-append change
// (array shrank, or what's rendered doesn't match p2pPrompts for some other
// reason) falls back to the safe full rebuild.
function updateP2pResults(newPrompts) {
  const prevLen = p2pResults.querySelectorAll('.p2p-card').length;
  const isPureAppend = newPrompts.length > prevLen && p2pPrompts.length === prevLen;
  p2pPrompts = newPrompts;
  p2pResultsCount.textContent = `Generated Prompts (${p2pPrompts.length})`;
  if (!isPureAppend) {
    renderP2pResults();
    return;
  }
  if (prevLen === 0) p2pResults.innerHTML = ''; // clear the "no prompts yet" hint before the first append
  const frag = document.createDocumentFragment();
  for (let i = prevLen; i < newPrompts.length; i++) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardHtmlP2p(newPrompts[i], i);
    frag.appendChild(wrap.firstElementChild);
  }
  p2pResults.appendChild(frag);
  if (p2pSelectAllOn) {
    // keep newly-appended cards consistent with an already-active "select all"
    p2pResults.querySelectorAll('.p2p-check').forEach(cb => { cb.checked = true; });
  }
}

// v0.9.3: per-card copy (top-right of the row, left of the word count)
// and edit (bottom-right, left of delete) actions, added to match the
// Metadata Generator cards. Edit follows the exact same toggle pattern
// (pencil <-> checkmark, contenteditable on/off) -- the only difference
// is where the result lands on "done editing": P2P has no per-item
// backend/session state (see the note above cardHtmlP2p), so the
// edited text is written straight back into the in-memory p2pPrompts
// array and the card's own word count is refreshed in place.
p2pResults.addEventListener('click', async (e) => {
  const card = e.target.closest('.p2p-card');
  if (!card) return;

  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const idx = parseInt(copyBtn.dataset.copy);
    if (!Number.isNaN(idx)) { await copyText(p2pPrompts[idx] || ''); flashCopied(copyBtn); }
    return;
  }

  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) {
    const idx = parseInt(editBtn.dataset.edit);
    const textEl = card.querySelector('.p2p-card-text');
    const nowEditing = !card.classList.contains('editing');
    card.classList.toggle('editing', nowEditing);
    if (textEl) textEl.setAttribute('contenteditable', nowEditing ? 'true' : 'false');
    editBtn.textContent = nowEditing ? '✓' : '✎';
    editBtn.title = nowEditing ? 'Done editing' : 'Edit this prompt';
    if (nowEditing) {
      textEl.focus();
    } else if (textEl && !Number.isNaN(idx)) {
      const newText = textEl.textContent;
      p2pPrompts[idx] = newText;
      const wcEl = card.querySelector('.p2p-card-wordcount');
      if (wcEl) wcEl.textContent = `${countWordsP2p(newText)} words`;
    }
    return;
  }

  const delBtn = e.target.closest('[data-delete]');
  if (delBtn) {
    const idx = parseInt(delBtn.dataset.delete);
    if (Number.isNaN(idx)) return;
    p2pPrompts.splice(idx, 1);
    renderP2pResults();
  }
});

function setP2pRunning(running) {
  btnP2pStart.disabled = running;
  btnP2pPause.disabled = !running;
  btnP2pStop.disabled = !running;
  if (!running) btnP2pPause.textContent = '⏸ Pause';
}

btnP2pStart.addEventListener('click', async () => {
  const count = parseInt(p2pCountInput.value) || 10;
  const creativity = p2pCreativityInput.value || 'Medium';
  const style = p2pStyleSel.value;
  const targetWords = parseInt(p2pLength.value) || 30;
  const concurrency = parseInt(p2pConcurrency.value) || 3;

  if (p2pUseImage) {
    if (!p2pImages.length) {
      p2pStatus.textContent = 'Add at least one reference image first.';
      return;
    }
  } else if (!p2pOriginal.value.trim()) {
    p2pStatus.textContent = 'Enter an original prompt first.';
    return;
  }

  p2pPrompts = [];
  renderP2pResults();
  p2pProgressWrap.style.display = 'block';
  p2pProgressBar.style.width = '0%';
  p2pStatus.textContent = 'Starting…';
  setP2pRunning(true);

  const res = await pywebview.api.start_prompt_to_prompt(
    p2pOriginal.value, count, creativity, style, targetWords, concurrency, p2pUseImage);
  if (!res.ok) {
    p2pStatus.textContent = res.error || 'Could not start generation.';
    setP2pRunning(false);
  }
});

btnP2pPause.addEventListener('click', async () => {
  const res = await pywebview.api.pause_prompt_to_prompt();
  btnP2pPause.textContent = res.paused ? '▶ Resume' : '⏸ Pause';
});

btnP2pStop.addEventListener('click', async () => {
  await pywebview.api.stop_prompt_to_prompt();
  setP2pRunning(false);
  p2pStatus.textContent = 'Cancelled.';
});

document.getElementById('btnP2pReset').addEventListener('click', async () => {
  await pywebview.api.stop_prompt_to_prompt();
  p2pOriginal.value = '';
  p2pOriginalWordCount.textContent = '0 words';
  await pywebview.api.clear_p2p_images();
  p2pImages = [];
  p2pThumbCache.clear();
  renderP2pImageGrid();
  p2pPrompts = [];
  renderP2pResults();
  p2pProgressWrap.style.display = 'none';
  p2pStatus.textContent = 'Ready.';
  setP2pRunning(false);
});

BackendEvents.on('p2p_progress', (p) => {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  p2pProgressBar.style.width = pct + '%';
  p2pStatus.textContent = p.msg || `Generating… ${p.done}/${p.total}`;
});

BackendEvents.on('p2p_partial', (p) => {
  updateP2pResults(p.prompts || []);
});

BackendEvents.on('p2p_completed', (p) => {
  updateP2pResults(p.prompts || []);
  p2pStatus.textContent = `Done — ${p2pPrompts.length} prompt(s) generated.`;
  setP2pRunning(false);
});

BackendEvents.on('p2p_error', (p) => {
  p2pStatus.textContent = p.message || 'Generation failed.';
  setP2pRunning(false);
});

// ---- Results toolbar: Select All / Copy All / Export TXT / Export CSV ----
document.getElementById('btnP2pSelectAll').addEventListener('click', (e) => {
  p2pSelectAllOn = !p2pSelectAllOn;
  p2pResults.querySelectorAll('.p2p-check').forEach(cb => { cb.checked = p2pSelectAllOn; });
  e.target.textContent = p2pSelectAllOn ? 'Deselect All' : 'Select All';
});

function selectedOrAllPrompts() {
  const checked = [...p2pResults.querySelectorAll('.p2p-check:checked')].map(cb => p2pPrompts[parseInt(cb.dataset.idx)]);
  return checked.length ? checked : p2pPrompts;
}

document.getElementById('btnP2pCopyAll').addEventListener('click', async (e) => {
  const list = selectedOrAllPrompts();
  await copyText(list.join('\n\n'));
  p2pStatus.textContent = `Copied ${list.length} prompt(s).`;
  flashCopied(e.currentTarget);
});

document.getElementById('btnP2pExportTxt').addEventListener('click', async () => {
  const res = await pywebview.api.export_p2p_prompts(selectedOrAllPrompts(), 'txt');
  if (res.cancelled) return;
  p2pStatus.textContent = res.ok ? `Saved: ${res.path}` : (res.error || 'Could not export.');
});

document.getElementById('btnP2pExportCsv').addEventListener('click', async () => {
  const res = await pywebview.api.export_p2p_prompts(selectedOrAllPrompts(), 'csv');
  if (res.cancelled) return;
  p2pStatus.textContent = res.ok ? `Saved: ${res.path}` : (res.error || 'Could not export.');
});

onPywebviewReady(() => {
  refreshP2pImages();
});
