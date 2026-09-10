const statusText = document.getElementById('status');
const statusModelText = document.getElementById('statusModel');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const cardGrid = document.getElementById('cardGrid');
const emptyState = document.getElementById('emptyState');
const genCountEl = document.getElementById('genCount');
const cardTemplate = document.getElementById('cardTemplate');

const dropzone = document.getElementById('dropzone');

// --- Grid state: append-only completion order, never resorted or
// rebuilt from scratch on update -- mirrors main_window.py's
// _completion_order / "cards never change position" rule. ---
const cardEls = new Map();   // path -> DOM node
const lastApplied = new Map(); // path -> JSON string, to skip no-op re-renders
let totalImported = 0;
let importedPaths = [];

// v0.9.4: selection + status tracking for the context-aware toolbar
// (Generate Selected / Remove Selected / Retry Failed / "Generate" ->
// "Generate Remaining" relabel). cardStatus only ever contains
// done/failed entries -- matching the existing "no card until
// done/failed" rule, waiting/working paths simply aren't in it yet,
// which is fine since nothing here needs to distinguish those two.
const selectedPaths = new Set();
const cardStatus = new Map(); // path -> 'done' | 'failed'
let generationRunning = false;
// v0.9.4 (item 11): tracks paths currently in 'working' status, purely
// for the progress breakdown's "processing" count -- applyCard sees
// every status transition (including working, even though it returns
// early without creating a card for it), so this is exact, not a guess.
const processingPaths = new Set();
// path -> {result, thumb, meta, node, index} snapshots kept just long
// enough to support Undo after a delete; cleared once the toast's own
// timer expires (see scheduleUndoExpiry below) so this can't grow
// unbounded over a long session.
const pendingUndoSnapshots = new Map();
const GRID_SLOTS = 30; // 10x3
const dropzoneText = document.getElementById('dropzoneText');
const btnEmbedBatch = document.getElementById('btnEmbedBatch');

function updateEmptyState() {
  emptyState.classList.toggle('visible', cardEls.size === 0);
}

function statusLabel(status) {
  return { waiting: '○ Waiting', working: '⟳ Working…', done: '✓ Done',
           failed: '✗ Failed', stopped: '■ Stopped' }[status] || status;
}

const thumbCache = new Map();
function setThumb(el, b64) {
  const holder = el.querySelector('.card-thumb');
  holder.innerHTML = `<img src="data:image/jpeg;base64,${b64}">`;
}

// v0.9.3: per-card info line (file name / original dimensions / on-disk
// size) shown under the thumbnail -- meta.width/height/size_bytes come
// from the *original* file (backend's get_original_file_meta), never
// the thumbnail or the downscaled AI-preview copy. Cached the same way
// thumbCache is, since both arrive from the same async prefetch and a
// card can be created before or after either one lands.
const fileMetaCache = new Map();
function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function setFileInfo(el, path, meta) {
  const nameEl = el.querySelector('.card-file-name');
  const dimsEl = el.querySelector('.card-file-dims');
  const sizeEl = el.querySelector('.card-file-size');
  if (nameEl) { nameEl.textContent = path.split(/[\\/]/).pop() || ''; nameEl.title = path; }
  if (dimsEl) dimsEl.textContent = (meta && meta.width && meta.height) ? `${meta.width}×${meta.height}` : '';
  if (sizeEl) sizeEl.textContent = meta ? formatFileSize(meta.size_bytes) : '';
}

const importGrid = document.getElementById('importGrid');
function renderImportGrid() {
  // The instructional text and the image grid share the same left
  // column and are mutually exclusive: as soon as anything is
  // imported/dropped, the text vanishes and the grid takes its place.
  // The Browse button's own column never changes.
  // Whole box is only a click-to-browse trigger while empty ("black"
  // state) -- once it's full of thumbnails a click here shouldn't
  // re-open the picker, so the dedicated Browse button in the action
  // row below is the fallback for that state.
  dropzone.classList.toggle('clickable', importedPaths.length === 0);
  if (importedPaths.length === 0) {
    importGrid.hidden = true;
    dropzoneText.hidden = false;
    return;
  }
  dropzoneText.hidden = true;
  importGrid.hidden = false;
  const overflow = importedPaths.length > GRID_SLOTS;
  const shown = overflow ? importedPaths.slice(0, GRID_SLOTS - 1) : importedPaths.slice(0, GRID_SLOTS);
  let html = shown.map(p => {
    const thumb = thumbCache.get(p);
    return `<div class="import-cell">${thumb ? `<img src="data:image/jpeg;base64,${thumb}">` : ''}</div>`;
  }).join('');
  if (overflow) {
    html += `<div class="import-cell import-cell-more">+${importedPaths.length - shown.length}</div>`;
  }
  importGrid.innerHTML = html;
}

// ---- Field counts: title/description now show BOTH character count
// and word count (v0.8.9 -- previously title showed chars only and
// description showed words only, so neither field's other metric was
// visible at all). Keywords keeps its own "how many keywords" count. ----
function countChars(text) { return (text || '').length; }
function countWords(text) { return (text || '').trim() ? text.trim().split(/\s+/).length : 0; }
function countKeywords(text) { return (text || '').split(',').map(s => s.trim()).filter(Boolean).length; }

function refreshCardCounts(el, result) {
  el.querySelector('.card-title-count').textContent = result.title
    ? `${countChars(result.title)} chars · ${countWords(result.title)} words` : '';
  el.querySelector('.card-desc-count').textContent = result.desc
    ? `${countChars(result.desc)} chars · ${countWords(result.desc)} words` : '';
  el.querySelector('.card-kw-count').textContent = result.kw ? `${countKeywords(result.kw)} keywords` : '';
}

function applyCard(path, result) {
  const key = JSON.stringify(result);
  if (lastApplied.get(path) === key) return; // no-op guard, same intent as _last_applied_result

  // v0.9.4: track working-status membership for the progress
  // breakdown's "processing" count, regardless of whether this status
  // is new/duplicate/creates-a-card -- every real status transition
  // passes through here.
  if (result.status === 'working') processingPaths.add(path);
  else processingPaths.delete(path);

  let el = cardEls.get(path);
  const isNew = !el;
  if (isNew) {
    // Only create a card once a path reaches done/failed -- never for
    // waiting/working, matching the "no placeholder cards" rule.
    if (result.status !== 'done' && result.status !== 'failed') {
      lastApplied.set(path, key);
      return;
    }
    el = cardTemplate.content.firstElementChild.cloneNode(true);
    el.dataset.path = path;
    cardGrid.appendChild(el); // append-only: new cards always go at the end
    cardEls.set(path, el);
    Animate.popIn(el);
    const cached = thumbCache.get(path);
    if (cached) setThumb(el, cached);
    setFileInfo(el, path, fileMetaCache.get(path));
  } else {
    Animate.flash(el, 'updated-flash');
  }

  const statusEl = el.querySelector('.card-status');
  statusEl.textContent = statusLabel(result.status);
  statusEl.className = 'card-status ' + (result.status || '');
  el.querySelector('.card-title').textContent = result.title || result.prompt || (result.error ? `Error: ${result.error}` : '—');
  el.querySelector('.card-desc').textContent = result.desc || '';
  el.querySelector('.card-kw').textContent = result.kw || '';
  el.querySelector('.card-model').textContent = result.model_used || '';
  el.classList.toggle('has-desc', !!result.desc);
  refreshCardCounts(el, result);

  // Regenerate button was disabled the moment it was clicked; a fresh
  // done/failed result means this card's regeneration is over, so
  // re-enable it here rather than on a timer -- also covers the
  // ordinary first-render case (button just starts enabled).
  const regenBtn = el.querySelector('.card-regen-btn');
  if (regenBtn && (result.status === 'done' || result.status === 'failed')) {
    regenBtn.disabled = false;
    regenBtn.classList.remove('spinning');
  }

  lastApplied.set(path, key);
  updateEmptyState();
  document.getElementById('gridCount').textContent = cardEls.size;
  if (result.status === 'done' || result.status === 'failed') {
    cardStatus.set(path, result.status);
  }
  updateActionButtons();
}

// ---- v0.9.4: context-aware action buttons ----------------------------
// RULE 3: Retry Failed only shown when failures exist. RULE 4: nothing
// here shows while generation is actively running (retrying/relabeling
// mid-run would race the in-flight batch). "Generate" itself relabels
// to "Generate Remaining (N)" once there's a mix of done + not-done,
// rather than adding a second, overlapping button for the same
// action -- start_generation already only targets non-done paths, so
// a separate button would just be the same action wearing a different
// label with its own state to keep in sync.
function updateActionButtons() {
  const retryBtn = document.getElementById('btnRetryFailed');
  const genLabel = document.getElementById('btnGenerateLabel');
  let done = 0, failed = 0;
  cardStatus.forEach((status) => { if (status === 'done') done++; else if (status === 'failed') failed++; });

  if (!generationRunning && failed > 0) {
    retryBtn.textContent = `↻ Retry Failed (${failed})`;
    retryBtn.removeAttribute('data-count-hidden');
  } else {
    retryBtn.setAttribute('data-count-hidden', '');
  }

  // v0.9.4: only ever touch this button's two inner spans' textContent
  // -- never innerHTML -- so the #genCount node other code already
  // holds a cached reference to (genCountEl, set once at module load)
  // is never replaced/orphaned.
  const remaining = totalImported - done;
  if (!generationRunning && totalImported > 0 && done > 0 && remaining > 0) {
    genLabel.textContent = '✨ Generate Remaining';
    genCountEl.textContent = remaining;
  } else if (!generationRunning) {
    genLabel.textContent = '✨ Generate';
    genCountEl.textContent = totalImported;
  }
}

function updateSelectionUI() {
  const bar = document.getElementById('selectionBar');
  const count = selectedPaths.size;
  document.getElementById('selectionCount').textContent = count;
  bar.classList.toggle('visible', count > 0);
  document.getElementById('btnGenerateSelected').textContent = `✨ Regenerate Selected (${count})`;
  document.getElementById('btnRemoveSelected').textContent = `🗑 Remove Selected (${count})`;
}

function setCardSelected(path, selected) {
  const el = cardEls.get(path);
  if (selected) selectedPaths.add(path); else selectedPaths.delete(path);
  if (el) {
    el.classList.toggle('selected', selected);
    const check = el.querySelector('.card-select-check');
    if (check) check.checked = selected;
  }
  updateSelectionUI();
}


// cards are created dynamically. Only the single card whose pencil
// was clicked becomes editable; every other card is untouched. ----
function fieldElAndKey(fieldRow) {
  const key = fieldRow.dataset.field; // 'title' | 'desc' | 'kw'
  const textEl = fieldRow.querySelector('.field-text');
  return { key, textEl };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text || '';
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* best effort */ }
    document.body.removeChild(ta);
  }
}

// v0.9.4 (item 12): shared copy-feedback helper -- every copy action
// in the app (title/desc/keywords fields, P2P prompt cards, P2P Copy
// All, API key copy) routes through this so the feedback is
// consistent and there's one implementation, not five. Icon-only
// buttons (the field-copy-btn / p2p-card-copy SVGs, which already use
// stroke="currentColor") just tint green via a class -- no icon swap
// needed. Text buttons ("Copy All") swap their label briefly instead,
// since a color tint alone is less noticeable on a text button.
// Re-triggering while still flashing resets the timer/restores the
// stored original first, rather than stacking or corrupting the label
// (item 12's "prevent double-click copy actions from causing weird UI
// states").
function flashCopied(btn) {
  if (!btn) return;
  if (btn.querySelector('svg')) {
    if (btn._copyFlashTimer) clearTimeout(btn._copyFlashTimer);
    btn.classList.add('copy-flash');
    btn._copyFlashTimer = setTimeout(() => { btn.classList.remove('copy-flash'); btn._copyFlashTimer = null; }, 1100);
  } else {
    if (btn._copyFlashTimer) { clearTimeout(btn._copyFlashTimer); btn.textContent = btn._copyFlashOriginal; }
    btn._copyFlashOriginal = btn._copyFlashOriginal || btn.textContent;
    btn.textContent = '✓ Copied';
    btn._copyFlashTimer = setTimeout(() => { btn.textContent = btn._copyFlashOriginal; btn._copyFlashTimer = null; }, 1100);
  }
}

async function pushFieldUpdate(path, field, value) {
  try { await pywebview.api.update_card_field(path, field, value); } catch (e) { /* best effort */ }
}

cardGrid.addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const path = card.dataset.path;

  // v0.9.4: selection checkbox -- handled first and returns immediately,
  // so it can never fall through into any of the other handlers below
  // (item 6: selection must not accidentally trigger open/edit/
  // regenerate/delete).
  const selectCheck = e.target.closest('.card-select-check');
  if (selectCheck) {
    setCardSelected(path, selectCheck.checked);
    return;
  }

  const regenBtn = e.target.closest('.card-regen-btn');
  if (regenBtn) {
    if (regenBtn.disabled) return;
    regenBtn.disabled = true;
    regenBtn.classList.add('spinning');
    const res = await pywebview.api.regenerate_card(path, 'meta', buildMetaGenOptions());
    if (!res.ok) {
      regenBtn.disabled = false;
      regenBtn.classList.remove('spinning');
      statusText.textContent = res.error || 'Could not regenerate this card.';
    }
    // On success the button is re-enabled by the next card_update for
    // this path (status flips waiting -> working -> done/failed), see
    // applyCard below -- not on a timer, so it can't re-enable early.
    return;
  }

  const deleteBtn = e.target.closest('.card-delete-btn');
  if (deleteBtn) {
    // v0.9.4: snapshot everything needed to restore this exact card
    // (including reusing the real DOM node, so Undo's "restore
    // position if possible" is exact for what the person actually
    // sees) *before* asking the backend to delete it -- card_removed
    // below is still the single source of truth for when the card
    // actually disappears from state.
    pendingUndoSnapshots.set(path, {
      result: JSON.parse(lastApplied.get(path) || '{}'),
      thumb: thumbCache.get(path),
      meta: fileMetaCache.get(path),
      node: card,
      index: Array.from(cardGrid.children).indexOf(card),
    });
    const res = await pywebview.api.delete_card(path);
    if (!res.ok) {
      pendingUndoSnapshots.delete(path);
      statusText.textContent = res.error || 'Could not delete this card.';
      return;
    }
    // card_removed (below) does the actual DOM/state cleanup so a
    // second delete click (or another page reload) can't double-remove.
    return;

  }

  const copyBtn = e.target.closest('.field-copy-btn');
  if (copyBtn) {
    const { textEl } = fieldElAndKey(copyBtn.closest('.card-field'));
    await copyText(textEl.textContent);
    flashCopied(copyBtn);
    return;
  }

  const pasteBtn = e.target.closest('.field-paste-btn');
  if (pasteBtn) {
    const { key, textEl } = fieldElAndKey(pasteBtn.closest('.card-field'));
    let pasted = '';
    try { pasted = await navigator.clipboard.readText(); } catch (e2) { return; }
    if (!pasted) return;
    textEl.textContent = pasted;
    const result = { title: card.querySelector('.card-title').textContent,
                      desc: card.querySelector('.card-desc').textContent,
                      kw: card.querySelector('.card-kw').textContent };
    card.classList.toggle('has-desc', !!result.desc);
    refreshCardCounts(card, result);
    await pushFieldUpdate(path, key, pasted);
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
      // Leaving edit mode: push every field's current text so backend
      // state (and the working CSV behind the Embed button) matches
      // whatever was actually left on screen.
      const result = { title: card.querySelector('.card-title').textContent,
                        desc: card.querySelector('.card-desc').textContent,
                        kw: card.querySelector('.card-kw').textContent };
      card.classList.toggle('has-desc', !!result.desc);
      refreshCardCounts(card, result);
      await pushFieldUpdate(path, 'title', result.title);
      await pushFieldUpdate(path, 'desc', result.desc);
      await pushFieldUpdate(path, 'kw', result.kw);
    }
  }
});

// Live counts while typing inside an editable field.
cardGrid.addEventListener('input', (e) => {
  const fieldText = e.target.closest('.field-text');
  if (!fieldText || fieldText.getAttribute('contenteditable') !== 'true') return;
  const card = fieldText.closest('.card');
  const result = { title: card.querySelector('.card-title').textContent,
                    desc: card.querySelector('.card-desc').textContent,
                    kw: card.querySelector('.card-kw').textContent };
  refreshCardCounts(card, result);
});

BackendEvents.on('thumb_ready', (p) => {
  thumbCache.set(p.path, p.thumb);
  const el = cardEls.get(p.path);
  if (el) setThumb(el, p.thumb);
  if (importedPaths.includes(p.path)) renderImportGrid();
});

BackendEvents.on('file_meta_ready', (p) => {
  fileMetaCache.set(p.path, p.meta);
  const el = cardEls.get(p.path);
  if (el) setFileInfo(el, p.path, p.meta);
});

BackendEvents.on('card_update', (p) => applyCard(p.path, p.result));

// v0.8.9: fired by Session.delete_card() -- the single source of
// truth for removing a card is the backend confirming the delete, not
// the click handler itself, so a second click (or a stray double
// event) can't try to remove an already-gone node.
BackendEvents.on('card_removed', (p) => {
  const el = cardEls.get(p.path);
  if (el) {
    Animate.fadeOut(el, () => el.remove());
  }
  cardEls.delete(p.path);
  lastApplied.delete(p.path);
  thumbCache.delete(p.path);
  cardStatus.delete(p.path);
  selectedPaths.delete(p.path);
  totalImported = Math.max(0, totalImported - 1);
  importedPaths = importedPaths.filter((x) => x !== p.path);
  updateEmptyState();
  document.getElementById('gridCount').textContent = cardEls.size;
  updateActionButtons();
  updateSelectionUI();

  // v0.9.4: Undo (item 4) -- only offer it if this delete actually
  // went through the click handler above (pendingUndoSnapshots has an
  // entry). A card removed some other way (e.g. a future bulk path
  // that doesn't stash a snapshot) just disappears with no Undo offer
  // rather than crashing on missing data.
  const snap = pendingUndoSnapshots.get(p.path);
  if (snap) {
    pendingUndoSnapshots.delete(p.path);
    Toast.show('Card removed', {
      type: 'info', duration: 7000,
      action: { label: 'Undo', onClick: () => restoreCard(p.path, snap) },
    });
  }
});

// v0.9.4: bulk sibling of card_removed, fired once by delete_cards()
// for 'Remove Selected' -- one grid update for the whole batch instead
// of one per card, and one combined Undo toast for the whole action.
BackendEvents.on('cards_removed', (p) => {
  const snaps = [];
  p.paths.forEach((path) => {
    const el = cardEls.get(path);
    if (el) Animate.fadeOut(el, () => el.remove());
    cardEls.delete(path);
    lastApplied.delete(path);
    thumbCache.delete(path);
    cardStatus.delete(path);
    selectedPaths.delete(path);
    importedPaths = importedPaths.filter((x) => x !== path);
    const snap = pendingUndoSnapshots.get(path);
    if (snap) { pendingUndoSnapshots.delete(path); snaps.push([path, snap]); }
  });
  totalImported = Math.max(0, totalImported - p.paths.length);
  updateEmptyState();
  document.getElementById('gridCount').textContent = cardEls.size;
  updateActionButtons();
  updateSelectionUI();

  if (snaps.length) {
    Toast.show(`${snaps.length} card${snaps.length === 1 ? '' : 's'} removed`, {
      type: 'info', duration: 7000,
      action: {
        label: 'Undo',
        onClick: async () => {
          // v0.9.4.1: restore in the *reverse* of deletion order, and
          // sequentially (awaited, not fired concurrently) -- the
          // backend's restore_card() reinserts each path at its
          // recorded original index against whatever all_paths/
          // completion_order looks like *right now*, and that's only
          // correct for a multi-item batch if the last-deleted item
          // is restored first (see session.py's restore_card
          // docstring for the worked example). Firing these
          // concurrently could let two restores race against the same
          // pre-update list state and land in the wrong order.
          const ordered = snaps.slice().reverse();
          for (const [path, snap] of ordered) {
            await restoreCard(path, snap);
          }
        },
      },
    });
  }
});

async function restoreCard(path, snapshot) {
  const res = await pywebview.api.restore_card(path, snapshot.result);
  if (!res.ok) return; // most likely: something else already re-added this path
  thumbCache.set(path, snapshot.thumb);
  fileMetaCache.set(path, snapshot.meta);
  // v0.9.4 fix: don't reuse snapshot.node directly. Animate.fadeOut
  // left a one-shot 'animationend' listener on it, AND (found by
  // actually tracing a fast-undo click, not just reasoning about it)
  // _restart's double-rAF class re-add can still be in flight at this
  // point -- simply stripping the 'fade-out' class here is not enough,
  // since that pending rAF callback re-adds it a moment later anyway,
  // restarting the animation and eventually firing that stale
  // listener's el.remove() on the very node we just reinserted. A
  // clone sheds every JS-attached listener (cardGrid's own click
  // handling is delegated, so the clone keeps working normally), so
  // there's nothing stale left to fire.
  // v0.9.4 fix (part 2): the original node can still be physically
  // sitting in the grid at this point too -- fadeOut's removal is
  // driven by a real (if short) CSS animation + a double-rAF restart
  // cycle, not something synchronous, so a fast Undo can land before
  // it's actually gone. Force it out unconditionally (a no-op if it's
  // already detached) so inserting the clone below can never produce
  // a visible duplicate of the same card.
  snapshot.node.remove();
  const node = snapshot.node.cloneNode(true);
  node.classList.remove('fade-out');
  const children = cardGrid.children;
  if (snapshot.index != null && snapshot.index <= children.length) {
    cardGrid.insertBefore(node, children[snapshot.index] || null);
  } else {
    cardGrid.appendChild(node);
  }
  cardEls.set(path, node);
  lastApplied.set(path, JSON.stringify(snapshot.result));
  if (!importedPaths.includes(path)) importedPaths.push(path);
  totalImported += 1;
  if (snapshot.result.status === 'done' || snapshot.result.status === 'failed') {
    cardStatus.set(path, snapshot.result.status);
  }
  Animate.popIn(node);
  updateEmptyState();
  document.getElementById('gridCount').textContent = cardEls.size;
  updateActionButtons();
}

BackendEvents.on('task_progress', (p) => {
  progressWrap.style.display = 'block';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  progressBar.style.width = pct + '%';
  statusText.textContent = p.msg || `Processing ${p.done}/${p.total}`;

  // v0.9.4 (item 11): success/failed/processing breakdown. success and
  // failed come straight from the backend's own counters (real, not
  // derived); processing is tracked client-side via card_update's
  // working-status transitions (see applyCard/processingPaths below),
  // since the backend doesn't need a third counter just for this --
  // the frontend already sees every status change anyway.
  if (typeof p.success === 'number' && typeof p.failed === 'number') {
    document.getElementById('progressBreakdown').style.display = 'flex';
    document.getElementById('pbSuccess').textContent = p.success;
    document.getElementById('pbFailed').textContent = p.failed;
    document.getElementById('pbProcessing').textContent = processingPaths.size;
  }
});

// v0.9.3: this used to overwrite the same element task_progress writes
// to, so the "Provider · model…" text would blot out the "[i/total]
// file.jpg" progress line whenever both fired close together. Now it
// has its own element, pinned to the far right of the same row.
BackendEvents.on('status_text', (p) => { statusModelText.textContent = p.msg; });

BackendEvents.on('task_completed', (p) => {
  statusText.textContent = `Done — ${p.total} images processed`;
  statusModelText.textContent = '';
  setGeneratingState(false);
  // v0.9.4: leave the breakdown chips showing the final tally (per
  // spec: "When complete: ✓ 97 successful · ✕ 3 failed") rather than
  // hiding them immediately -- they get reset on the next Start/Clear.
  document.getElementById('pbProcessing').textContent = '0';
  // Only a natural full completion reaches this event (Stop never
  // fires task_completed -- see session.py's _on_all_done), matching
  // the original app's "Embed button only after a full generation
  // completion" rule.
  btnEmbedBatch.style.display = 'inline-block';
});

function setGeneratingState(running) {
  generationRunning = running;
  document.getElementById('btnGenerate').disabled = running;
  document.getElementById('btnPause').disabled = !running;
  document.getElementById('btnStop').disabled = !running;
  if (running) btnEmbedBatch.style.display = 'none'; // hide again once a new run starts
  updateActionButtons();
}

// v0.8.4: no more popup window (Hasib's "no pop-up" request) --
// switches to the Embed page in this same window (goToPage, from
// nav.js) and auto-imports the image folder + generated CSV via
// embed.js's autoLoadEmbedBatch(), same real bridge call the old popup
// used, just triggered in-page now.
btnEmbedBatch.addEventListener('click', () => {
  goToPage('embed');
  if (typeof autoLoadEmbedBatch === 'function') autoLoadEmbedBatch();
});

// --- Real native file browse (import wiring is real; drag-drop path
// retrieval from the browser side is still a visual-only stub, see
// README) --- Shared by the small Browse button in the action row AND
// the dropzone box itself acting as one giant browse trigger while empty.
async function doBrowseImages() {
  statusText.textContent = 'Opening file picker…';
  const res = await pywebview.api.browse_images();
  if (!res.ok) { statusText.textContent = 'Could not open file picker.'; return; }
  totalImported += res.accepted.length;
  genCountEl.textContent = totalImported;
  importedPaths.push(...res.accepted);
  renderImportGrid();
  statusText.textContent = '';
  Toast.showImportSummary(res.accepted, res.rejected);
  if (res.accepted.length) Animate.dropSuccess(dropzone);
}

document.getElementById('btnBrowse').addEventListener('click', doBrowseImages);

// The dropzone box itself: a click anywhere inside it opens the same
// picker, but ONLY while it's still empty/"black" -- .clickable is
// toggled off the moment images are imported (see renderImportGrid),
// so clicking the thumbnail grid afterward doesn't re-trigger it.
dropzone.addEventListener('click', () => {
  if (importedPaths.length === 0) doBrowseImages();
});

// Real drag-and-drop results: bound on the Python side (app.py's
// _bind_real_drag_drop, using pywebview's DOM event API for the real
// filesystem path), which calls session.add_paths directly and emits
// this event -- the drop itself never touches this JS file.
BackendEvents.on('import_completed', (res) => {
  totalImported += res.accepted.length;
  genCountEl.textContent = totalImported;
  importedPaths.push(...res.accepted);
  renderImportGrid();
  Toast.showImportSummary(res.accepted, res.rejected);
  if (res.accepted.length) Animate.dropSuccess(dropzone);
});

// ---- Build the options object generation reads from the control
// panel -- extracted (v0.8.9) so both the main Generate button and a
// single card's Regenerate button build the exact same options from
// whatever's currently on screen, instead of duplicating this list. ----
function buildMetaGenOptions() {
  const fileType = document.getElementById('optFileType').value;
  return {
    title_chars: parseInt(document.getElementById('optTitleChars').value) || 130,
    desc_chars: parseInt(document.getElementById('optDescChars').value) || 200,
    kw_count: parseInt(document.getElementById('optKwCount').value) || 49,
    concurrency: parseInt(document.getElementById('optConcurrency').value) || 10,
    single_kw: document.getElementById('optSingleKw').checked,
    avoid_copyright: document.getElementById('optAvoidCopyright').checked,
    include_desc: document.getElementById('optIncludeDesc').checked,
    prefix_on: document.getElementById('optPrefixOn').checked,
    prefix: document.getElementById('optPrefixText').value,
    suffix_on: document.getElementById('optSuffixOn').checked,
    suffix: document.getElementById('optSuffixText').value,
    custom: document.getElementById('optCustomPrompt').value,
    content_phrase: (contentTypesCache[fileType] || ''),
    auto_download_csv: document.getElementById('optAutoDownloadCsv').checked,
  };
}

function resetProgressBreakdown() {
  document.getElementById('progressBreakdown').style.display = 'none';
  document.getElementById('pbSuccess').textContent = '0';
  document.getElementById('pbFailed').textContent = '0';
  document.getElementById('pbProcessing').textContent = '0';
}

document.getElementById('btnGenerate').addEventListener('click', async () => {
  const options = buildMetaGenOptions();
  statusText.textContent = 'Starting…';
  statusModelText.textContent = '';
  resetProgressBreakdown();
  setGeneratingState(true);
  const res = await pywebview.api.start_generation('meta', options);
  if (!res.ok) {
    statusText.textContent = res.error || 'Could not start generation.';
    setGeneratingState(false);
  }
});

// v0.9.4: Retry Failed -- only visible when failures exist (see
// updateActionButtons). Passes the exact set of failed paths the
// frontend already knows about, reusing start_generation_for_paths
// rather than a bespoke "retry" backend endpoint.
document.getElementById('btnRetryFailed').addEventListener('click', async () => {
  const failedPaths = Array.from(cardStatus.entries()).filter(([, s]) => s === 'failed').map(([p]) => p);
  if (!failedPaths.length) return;
  const options = buildMetaGenOptions();
  statusText.textContent = 'Retrying failed…';
  statusModelText.textContent = '';
  resetProgressBreakdown();
  setGeneratingState(true);
  const res = await pywebview.api.start_generation_for_paths(failedPaths, 'meta', options);
  if (!res.ok) {
    statusText.textContent = res.error || 'Could not retry failed cards.';
    setGeneratingState(false);
  }
});

// v0.9.4: contextual selection toolbar actions (items 6-8, 13).
document.getElementById('btnGenerateSelected').addEventListener('click', async () => {
  const paths = Array.from(selectedPaths);
  if (!paths.length) return;
  const options = buildMetaGenOptions();
  const count = paths.length;
  statusText.textContent = `Generating ${count} selected…`;
  statusModelText.textContent = '';
  resetProgressBreakdown();
  setGeneratingState(true);
  const res = await pywebview.api.start_generation_for_paths(paths, 'meta', options);
  if (!res.ok) {
    statusText.textContent = res.error || 'Could not generate selected cards.';
    setGeneratingState(false);
  }
});

document.getElementById('btnRemoveSelected').addEventListener('click', async () => {
  const paths = Array.from(selectedPaths);
  if (!paths.length) return;
  paths.forEach((path) => {
    const el = cardEls.get(path);
    if (!el) return;
    pendingUndoSnapshots.set(path, {
      result: JSON.parse(lastApplied.get(path) || '{}'),
      thumb: thumbCache.get(path),
      meta: fileMetaCache.get(path),
      node: el,
      index: Array.from(cardGrid.children).indexOf(el),
    });
  });
  await pywebview.api.delete_cards(paths);
  // cards_removed (above) does the actual DOM/state cleanup + Undo toast.
});

// v0.9.5: Select All -- selects every currently rendered card (i.e.
// every path with a card, done/failed; matches what the checkbox
// selection mechanism itself covers). Sits to the left of Clear
// Selection in the contextual bar (see index.html), so like the rest
// of that bar it's only ever visible once something can be selected.
document.getElementById('btnSelectAll').addEventListener('click', () => {
  cardEls.forEach((el, path) => {
    selectedPaths.add(path);
    el.classList.add('selected');
    const check = el.querySelector('.card-select-check');
    if (check) check.checked = true;
  });
  updateSelectionUI();
});

document.getElementById('btnClearSelection').addEventListener('click', () => {
  selectedPaths.forEach((path) => {
    const el = cardEls.get(path);
    if (el) {
      el.classList.remove('selected');
      const check = el.querySelector('.card-select-check');
      if (check) check.checked = false;
    }
  });
  selectedPaths.clear();
  updateSelectionUI();
});

// ---- Control panel wiring: platform/file-type options, sliders,
// advanced options collapse, prefix/suffix reveal, reset ----
let platformsCache = {};
let contentTypesCache = {};

async function loadMetaOptions() {
  const res = await pywebview.api.get_meta_options();
  if (!res.ok) return;
  platformsCache = res.platforms;
  contentTypesCache = res.content_types;

  const platSel = document.getElementById('optPlatform');
  platSel.innerHTML = Object.keys(platformsCache).map(p => `<option>${p}</option>`).join('');
  const ftSel = document.getElementById('optFileType');
  ftSel.innerHTML = Object.keys(contentTypesCache).map(t => `<option>${t}</option>`).join('');

  applyPlatformDefaults(platSel.value);
}

function applyPlatformDefaults(platform) {
  const rule = platformsCache[platform];
  if (!rule) return;
  const titleInput = document.getElementById('optTitleChars');
  const descInput = document.getElementById('optDescChars');
  const kwInput = document.getElementById('optKwCount');
  const descToggle = document.getElementById('optIncludeDesc');
  const descRow = descToggle.closest('.control-toggle-row');

  // Cap the slider's own max at the platform's real limit (not just its
  // starting value) -- otherwise you could drag a slider that's sitting
  // at, say, 200/300 up past what Adobe Stock actually allows.
  if (rule.title_chars) {
    titleInput.max = rule.title_chars;
    titleInput.value = rule.title_chars;
    document.getElementById('titleCharsVal').textContent = rule.title_chars;
  }
  if (rule.kw_count) {
    kwInput.max = rule.kw_count;
    kwInput.value = rule.kw_count;
    document.getElementById('kwCountVal').textContent = rule.kw_count;
  }

  // has_desc:false (Adobe Stock has no real description field) turns
  // the whole Description control off rather than just capping its
  // length at 0 -- matches what the platform actually accepts.
  const hasDesc = rule.has_desc !== false;
  descToggle.disabled = !hasDesc;
  descInput.disabled = !hasDesc;
  if (descRow) descRow.classList.toggle('control-disabled', !hasDesc);
  if (!hasDesc) {
    descToggle.checked = false;
  } else {
    // v0.8.7 fix: switching FROM a no-description platform (Adobe
    // Stock) correctly turned the toggle off, but switching back TO a
    // platform that supports descriptions (Shutterstock etc.) never
    // turned it back on -- this branch only ever touched .max/.value,
    // never .checked, so the toggle stayed off until the user noticed
    // and flipped it manually.
    descToggle.checked = true;
    if (rule.desc_chars) {
      descInput.max = rule.desc_chars;
      descInput.value = rule.desc_chars;
      document.getElementById('descCharsVal').textContent = rule.desc_chars;
    }
  }
}

document.getElementById('optPlatform').addEventListener('change', (e) => applyPlatformDefaults(e.target.value));

// live slider labels
const sliderPairs = [
  ['optConcurrency', 'concurrencyVal', v => v + 'x'],
  ['optTitleChars', 'titleCharsVal', v => v],
  ['optDescChars', 'descCharsVal', v => v],
  ['optKwCount', 'kwCountVal', v => v],
];
sliderPairs.forEach(([inputId, labelId, fmt]) => {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  input.addEventListener('input', () => { label.textContent = fmt(input.value); });
});

// Advanced Options collapse
// v0.8.8: was a raw `hidden` attribute toggle (can't be animated --
// [hidden] is display:none with no transition path); now driven by
// the `.open` class so .advanced-body's CSS transition (see
// base.css) can animate the fade/slide open and closed.
const advBody = document.getElementById('advancedBody');
document.getElementById('btnToggleAdvanced').addEventListener('click', () => {
  const willShow = !advBody.classList.contains('open');
  advBody.classList.toggle('open', willShow);
  document.getElementById('btnToggleAdvanced').textContent = (willShow ? '▼' : '▶') + ' Advanced Options';
});

// Prefix/Suffix input reveal
document.getElementById('optPrefixOn').addEventListener('change', (e) => {
  document.getElementById('optPrefixText').hidden = !e.target.checked;
});
document.getElementById('optSuffixOn').addEventListener('change', (e) => {
  document.getElementById('optSuffixText').hidden = !e.target.checked;
});

document.getElementById('btnResetDefaults').addEventListener('click', () => {
  document.getElementById('optCustomPrompt').value = '';
  applyPlatformDefaults(document.getElementById('optPlatform').value);
});

// The control panel no longer has its own API Manager button (removed
// per request -- it's still reachable from the sidebar's API nav item
// and the Dashboard's quick-launch tile). This panel now only shows a
// quick summary of key counts.
async function refreshKeySummary() {
  const res = await pywebview.api.get_active_keys_summary();
  const el = document.getElementById('keySummary');
  el.innerHTML = `
    <div class="key-summary-item"><strong>${res.active_count}</strong>Active</div>
    <div class="key-summary-item"><strong>${res.stored_count}</strong>Stored</div>
    <div class="key-summary-item"><strong>${res.provider_count}</strong>Providers</div>`;
}

onPywebviewReady(() => {
  loadMetaOptions();
  refreshKeySummary();
  loadConcurrencyPref();
  loadAutoDownloadCsvPref();
  loadAppVersion();
  loadCardColumnsPref();
});

// v0.9.3: View dropdown -- 2/3/4-column card grid, persisted the same
// get_prefs/save_prefs merge way Concurrent Generations already is.
// The fade is a plain opacity transition (.view-fading, see base.css):
// fade out, swap the column count while invisible, fade back in --
// deliberately not an instant "harsh" grid-template-columns snap.
const viewSelect = document.getElementById('viewSelect');
const btnViewSelect = document.getElementById('btnViewSelect');
const viewSelectMenu = document.getElementById('viewSelectMenu');

btnViewSelect.addEventListener('click', (e) => {
  e.stopPropagation();
  viewSelect.classList.toggle('open');
  btnViewSelect.setAttribute('aria-expanded', viewSelect.classList.contains('open') ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
  if (viewSelect.classList.contains('open') && !viewSelect.contains(e.target)) {
    viewSelect.classList.remove('open');
    btnViewSelect.setAttribute('aria-expanded', 'false');
  }
});

function setCardColumns(cols, { fade = true } = {}) {
  viewSelectMenu.querySelectorAll('.view-select-option').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.cols) === cols);
  });
  const apply = () => { cardGrid.dataset.cols = String(cols); };
  if (!fade) { apply(); return; }
  cardGrid.classList.add('view-fading');
  setTimeout(() => {
    apply();
    // Force layout before removing the class so the fade-back-in
    // transition actually plays instead of being coalesced away.
    void cardGrid.offsetWidth;
    cardGrid.classList.remove('view-fading');
  }, 180);
}

viewSelectMenu.querySelectorAll('.view-select-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    const cols = parseInt(btn.dataset.cols) || 3;
    setCardColumns(cols);
    viewSelect.classList.remove('open');
    btnViewSelect.setAttribute('aria-expanded', 'false');
    await pywebview.api.save_prefs({ meta_card_columns: cols });
  });
});

async function loadCardColumnsPref() {
  const res = await pywebview.api.get_prefs();
  const saved = res.ok ? res.prefs.meta_card_columns : null;
  const cols = [2, 3, 4].includes(saved) ? saved : 3;
  setCardColumns(cols, { fade: false });
}

// v0.9.3: topbar version pill now reads the real APP_VERSION constant
// instead of a second hardcoded string in index.html that can silently
// drift out of sync with it (exactly what happened: pill said v0.9.1
// while constants.py already said v0.9.2).
async function loadAppVersion() {
  const res = await pywebview.api.get_app_version();
  if (res.ok) document.getElementById('versionPill').textContent = res.version;
}

// v0.8.4: Concurrent Generations defaults to 10 on a fresh install
// (no prefs.json entry yet), then remembers whatever the user last set
// it to via the same real get_prefs/save_prefs merge bridge Settings
// already uses -- saved on 'change' (slider release), not 'input', so
// dragging doesn't hammer disk writes.
const optConcurrencyEl = document.getElementById('optConcurrency');
async function loadConcurrencyPref() {
  const res = await pywebview.api.get_prefs();
  const saved = res.ok ? res.prefs.meta_concurrency : null;
  const value = (saved && saved >= 1 && saved <= 20) ? saved : 10;
  optConcurrencyEl.value = value;
  document.getElementById('concurrencyVal').textContent = value + 'x';
}
optConcurrencyEl.addEventListener('change', () => {
  pywebview.api.save_prefs({ meta_concurrency: parseInt(optConcurrencyEl.value) || 10 });
});

// v0.8.6: Auto Download CSV toggle -- persisted the same way
// optConcurrency is (get_prefs/save_prefs merge), read back into
// btnGenerate's options object above as auto_download_csv.
// v0.8.8: the toggle now lives inside a bordered .btn-toggle box (see
// index.html) so it visually matches Clear All/Generate/Pause/Stop --
// clicking anywhere in that box (not just the small switch itself)
// toggles the checkbox. Clicks landing on the switch/its label are
// left alone so the switch's own native label-click isn't doubled up
// (which would toggle it twice and appear to do nothing).
const optAutoDownloadCsvEl = document.getElementById('optAutoDownloadCsv');
const autoCsvToggleWrap = document.getElementById('autoCsvToggleWrap');
async function loadAutoDownloadCsvPref() {
  const res = await pywebview.api.get_prefs();
  optAutoDownloadCsvEl.checked = !!(res.ok && res.prefs.meta_auto_download_csv);
  autoCsvToggleWrap.setAttribute('aria-checked', String(optAutoDownloadCsvEl.checked));
}
optAutoDownloadCsvEl.addEventListener('change', () => {
  pywebview.api.save_prefs({ meta_auto_download_csv: optAutoDownloadCsvEl.checked });
  autoCsvToggleWrap.setAttribute('aria-checked', String(optAutoDownloadCsvEl.checked));
});
autoCsvToggleWrap.addEventListener('click', (e) => {
  if (e.target.closest('.switch')) return;
  optAutoDownloadCsvEl.click();
});
autoCsvToggleWrap.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); optAutoDownloadCsvEl.click(); }
});

// v0.8.6: manual "⬇ Download CSV" button -- opens a native Save
// dialog (bridge's export_csv(auto=false)) defaulting to the batch's
// common image folder, same #_FolderName.csv naming as auto-download.
document.getElementById('btnDownloadCsv').addEventListener('click', async () => {
  const res = await pywebview.api.export_csv(false);
  if (res.cancelled) return;
  statusText.textContent = res.ok ? `CSV saved: ${res.path}` : (res.error || 'Could not export CSV.');
});

document.getElementById('btnCollapsePanel').addEventListener('click', () => {
  const panel = document.getElementById('controlPanel');
  const btn = document.getElementById('btnCollapsePanel');
  const collapsed = panel.classList.toggle('collapsed');
  // v0.9.3.1: rotate the same chevron icon 180deg instead of swapping
  // "<"/">" glyphs -- see .panel-collapse-btn.collapsed in base.css.
  btn.classList.toggle('collapsed', collapsed);
  btn.title = collapsed ? 'Show panel' : 'Hide panel';
});

document.getElementById('btnPause').addEventListener('click', async () => {
  const res = await pywebview.api.pause_generation();
  document.getElementById('btnPause').textContent = res.paused ? '▶ Resume' : '⏸ Pause';
});

document.getElementById('btnStop').addEventListener('click', async () => {
  await pywebview.api.stop_generation();
  setGeneratingState(false);
  statusText.textContent = 'Stopped.';
  statusModelText.textContent = '';
});

document.getElementById('btnCheckKeys').addEventListener('click', async (e) => {
  e.stopPropagation(); // this box is also a click-to-navigate button now -- Check must stay its own action
  const res = await pywebview.api.get_active_keys_summary();
  statusText.textContent = res.active_count
    ? `Active keys: ${res.active_count} (${res.providers.join(', ')})`
    : 'No active API keys configured — open Settings.';
});

// v0.9.5.1: the API-info box (label + live key-count summary) is a
// click-to-navigate shortcut to the API Manager page, in addition to
// showing the info -- it was reported as having lost this behavior at
// some point; restoring it here explicitly with the standard
// goToPage() navigation helper (see nav.js) rather than a one-off.
[document.getElementById('apiInfoNav'), document.getElementById('keySummary')].forEach((el) => {
  el.addEventListener('click', () => goToPage('settings'));
});

document.getElementById('btnClear').addEventListener('click', async () => {
  // v0.9.4 (item 3): only interrupt with a confirmation when there's
  // something meaningful to lose -- an active generation. Clearing an
  // already-idle batch behaves exactly as before, no extra click.
  if (generationRunning) {
    const ok = await Confirm.show({
      title: 'Generation is currently running',
      message: 'Clearing the batch will stop the current generation and remove the current images and results.',
      confirmLabel: 'Stop & Clear',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
  }
  await pywebview.api.clear_batch();
  cardGrid.innerHTML = '';
  cardEls.clear();
  lastApplied.clear();
  thumbCache.clear();
  cardStatus.clear();
  selectedPaths.clear();
  pendingUndoSnapshots.clear();
  totalImported = 0;
  importedPaths = [];
  renderImportGrid();
  genCountEl.textContent = '0';
  progressWrap.style.display = 'none';
  btnEmbedBatch.style.display = 'none';
  statusText.textContent = 'Batch cleared.';
  statusModelText.textContent = '';
  resetProgressBreakdown();
  processingPaths.clear();
  updateEmptyState();
  setGeneratingState(false);
  updateSelectionUI();
});

// --- Drag/drop visual feedback only (see README: real path handoff
// from browser drag-drop is a known open item, not silently assumed done) ---
// v0.9.3: real root cause of the "blocked" cursor icon showing for a
// moment before the correct one -- preventDefault() alone stops the
// browser's default reject action, but Chromium/WebView2 still needs
// dataTransfer.dropEffect explicitly set on the same event to pick
// the "copy" cursor glyph instead of "no-drop". Confirmed by reading
// pywebview's own DOMEventHandler source (webview/dom/element.py):
// its generated listener already calls preventDefault() synchronously
// on every native event regardless of the `debounce` option (debounce
// only delays the follow-up Python callback dispatch), so that path
// was already correct and not the cause -- this was the missing piece.
['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('drag-active');
  })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag-active'); })
);

updateEmptyState();

// Exposed on `window` deliberately: pywebview's evaluate_js (used both
// for automated verification and any future Python-side debugging)
// cannot see plain top-level `const`/`let` bindings in this file --
// only explicit window properties. Real in-page behavior (buttons,
// event dispatch) doesn't need this, since those are normal same-
// script closures; this hook exists purely for introspection from
// the Python side.
window.__debugState = () => ({
  cardCount: cardEls.size,
  totalImported,
  firstCardStatus: cardGrid.querySelector('.card-status')?.textContent || null,
  firstCardTitle: cardGrid.querySelector('.card-title')?.textContent || null,
  hasThumb: !!cardGrid.querySelector('.card-thumb img'),
  progressWidth: progressBar.style.width,
  statusText: statusText.textContent,
  generateDisabled: document.getElementById('btnGenerate').disabled,
});
