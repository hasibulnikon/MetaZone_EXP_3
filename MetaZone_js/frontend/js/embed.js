const csvStatus = document.getElementById('csvStatus');
const folderStatus = document.getElementById('folderStatus');
const matchCountStatus = document.getElementById('matchCountStatus');
const embedLog = document.getElementById('embedLog');
const embedProgressWrap = document.getElementById('embedProgressWrap');
const embedProgressBar = document.getElementById('embedProgressBar');
const embedCounts = document.getElementById('embedCounts');
const embedCsvDropzone = document.getElementById('embedCsvDropzone');
const embedFolderDropzone = document.getElementById('embedFolderDropzone');

// v0.9.x (Part 16): embedLog.textContent += ... and a forced scrollTop
// read/write on every single event.log line -- for a large batch with
// hundreds of log lines arriving in rapid succession (even within one
// bridge-batched dispatch, see events.js), each line was its own full
// text-content rebuild (string concat over the whole log) plus a forced
// layout read. Buffered instead: incoming lines are queued into
// pendingLogLines and appended as one real text node per
// requestAnimationFrame flush, so a burst of 200 lines costs one DOM
// write and one scroll update per frame, not 200. Auto-scroll only
// keeps happening if the user was already at (or near) the bottom, so a
// user who's manually scrolled up to read earlier lines isn't yanked
// back down by every new line.
let pendingLogLines = [];
let logFlushScheduled = false;
function scheduleLogFlush() {
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  requestAnimationFrame(() => {
    logFlushScheduled = false;
    if (!pendingLogLines.length) return;
    const nearBottom = embedLog.scrollHeight - embedLog.scrollTop - embedLog.clientHeight < 40;
    embedLog.appendChild(document.createTextNode(pendingLogLines.join('')));
    pendingLogLines = [];
    if (nearBottom) embedLog.scrollTop = embedLog.scrollHeight;
  });
}
function clearEmbedLog() {
  pendingLogLines = [];
  embedLog.textContent = '';
}

let currentFolder = '';
let currentHeaders = [];

// v0.8.4: the Concurrent slider was removed from this page's UI to
// match the original app's exact layout (Hasib's request) -- runs at
// this fixed value instead of a user-exposed control. Still real
// (embedder.py's options.concurrency), just not surfaced here anymore.
const EMBED_CONCURRENCY = 6;

function fillColumnSelects(headers, guessed) {
  const selects = {
    filename: document.getElementById('colFilename'),
    title: document.getElementById('colTitle'),
    keywords: document.getElementById('colKeywords'),
    description: document.getElementById('colDescription'),
  };
  for (const [field, sel] of Object.entries(selects)) {
    sel.innerHTML = '<option value="">(skip)</option>' +
      headers.map(h => `<option value="${h}">${h}</option>`).join('');
    if (guessed && guessed[field]) sel.value = guessed[field];
  }
}

// ---- Match count preview (v0.8.7): "how many files are matched with
// the CSV against the located folder", shown under File Location as
// soon as a CSV, a folder, and a Filename column are all present, and
// refreshed whenever any of those (or the subfolder/extension-match
// toggles) change. ----
async function refreshMatchCount() {
  const fileCol = document.getElementById('colFilename').value;
  if (!currentFolder || !currentHeaders.length || !fileCol) {
    matchCountStatus.hidden = true;
    return;
  }
  const res = await pywebview.api.preview_embed_match(
    currentFolder, fileCol,
    document.getElementById('optSubfolders').checked,
    document.getElementById('optMatchExt').checked);
  if (!res.ok) { matchCountStatus.hidden = true; return; }
  matchCountStatus.hidden = false;
  matchCountStatus.textContent = `${res.matched} of ${res.total} CSV rows matched in this folder`;
  Animate.pulse(matchCountStatus);
}
['colFilename'].forEach(id => document.getElementById(id).addEventListener('change', refreshMatchCount));
['optSubfolders', 'optMatchExt'].forEach(id => document.getElementById(id).addEventListener('change', refreshMatchCount));

document.getElementById('btnBrowseCsv').addEventListener('click', async () => {
  const res = await pywebview.api.browse_csv();
  if (!res.ok) {
    if (!res.cancelled) csvStatus.textContent = res.error || 'Could not load CSV.';
    return;
  }
  applyCsvResult(res);
});

document.getElementById('btnBrowseFolder').addEventListener('click', async () => {
  const res = await pywebview.api.browse_embed_folder();
  if (!res.ok) {
    if (!res.cancelled) folderStatus.textContent = res.error || 'Could not select folder.';
    return;
  }
  applyFolderResult(res);
});

function applyCsvResult(res) {
  currentHeaders = res.headers;
  csvStatus.textContent = `✓ ${res.rows} rows loaded`;
  Animate.pulse(csvStatus);
  fillColumnSelects(res.headers, res.guessed_columns);
  if (res.guessed_folder && !currentFolder) {
    currentFolder = res.guessed_folder;
    folderStatus.textContent = `✓ ${res.guessed_folder} (from CSV)`;
    Animate.pulse(folderStatus);
  }
  if (res.folder) {
    currentFolder = res.folder;
    folderStatus.textContent = `✓ ${res.folder}`;
    Animate.pulse(folderStatus);
  }
  Animate.dropSuccess(embedCsvDropzone);
  refreshMatchCount();
}

function applyFolderResult(res) {
  currentFolder = res.folder;
  folderStatus.textContent = `✓ ${res.folder}`;
  Animate.pulse(folderStatus);
  Animate.dropSuccess(embedFolderDropzone);
  refreshMatchCount();
}

// ---- Drag-and-drop: the real filesystem-path binding lives in
// app.py's element-scoped DOMEventHandlers (#embedCsvDropzone /
// #embedFolderDropzone, same pywebviewFullPath mechanism as every
// other real drop target in this app) -- these listeners only supply
// the visual drag-active affordance and react to the events those
// Python handlers emit once a real drop completes. ----
[[embedCsvDropzone, 'embed_csv_dropped'], [embedFolderDropzone, 'embed_folder_dropped']].forEach(([el]) => {
  // v0.9.3: same dropEffect fix as app.js's dropzone -- see that file
  // for the full root-cause note.
  ['dragenter', 'dragover'].forEach(evt => el.addEventListener(evt, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-active');
  }));
  ['dragleave', 'drop'].forEach(evt => el.addEventListener(evt, (e) => { e.preventDefault(); el.classList.remove('drag-active'); }));
});

BackendEvents.on('embed_csv_dropped', (res) => {
  if (!res.ok) { csvStatus.textContent = res.error || 'Could not load dropped CSV.'; return; }
  applyCsvResult(res);
});

BackendEvents.on('embed_folder_dropped', (res) => {
  if (!res.ok) { folderStatus.textContent = res.error || 'Could not use dropped folder.'; return; }
  applyFolderResult(res);
});

// v0.9.4 (item 14): Dry Run -- categorizes every CSV row against the
// selected folder without touching any file, using the exact same
// columns/options shape start_embed already builds (mirrored here
// rather than duplicated logic diverging over time).
let dryRunRows = [];
let dryRunFilter = 'all';

function collectEmbedColumns() {
  return {
    filename: document.getElementById('colFilename').value || null,
    title: document.getElementById('colTitle').value || null,
    keywords: document.getElementById('colKeywords').value || null,
    description: document.getElementById('colDescription').value || null,
  };
}
function collectEmbedOptions() {
  return {
    subfolders: document.getElementById('optSubfolders').checked,
    match_ext_only: document.getElementById('optMatchExt').checked,
  };
}

function renderDryRunRows() {
  const list = document.getElementById('dryRunRows');
  const rows = dryRunFilter === 'all' ? dryRunRows : dryRunRows.filter(r => r.category === dryRunFilter);
  // v0.9.4 perf: cap the rendered list rather than dumping potentially
  // thousands of rows into the DOM at once -- the summary counts above
  // already reflect the true total regardless of what's rendered here.
  const CAP = 500;
  const shown = rows.slice(0, CAP);
  const labels = { matched: 'Matched', missing_image: 'Missing Image', missing_metadata: 'Missing Metadata', unsupported: 'Unsupported', already_embedded: 'Already Embedded' };
  list.innerHTML = shown.map(r => `
    <div class="dry-run-row">
      <span class="dry-run-row-name" title="${(r.filename || '(blank)').replace(/"/g, '&quot;')}">${r.filename || '(blank filename)'}</span>
      <span class="dry-run-row-cat ${r.category}">${labels[r.category]}</span>
    </div>`).join('') + (rows.length > CAP ? `<div class="hint-text" style="padding:6px;">…and ${rows.length - CAP} more</div>` : '');
}

document.getElementById('dryRunFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('.dry-run-filter-btn');
  if (!btn) return;
  dryRunFilter = btn.dataset.filter;
  document.querySelectorAll('.dry-run-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderDryRunRows();
});

document.getElementById('btnDryRun').addEventListener('click', async () => {
  const btn = document.getElementById('btnDryRun');
  const columns = collectEmbedColumns();
  if (!columns.filename) {
    Toast.show('Select the filename column first', { type: 'warning' });
    return;
  }
  if (!currentFolder) {
    Toast.show('Select a folder first', { type: 'warning' });
    return;
  }
  btn.disabled = true;
  const res = await pywebview.api.dry_run_embed(currentFolder, columns, collectEmbedOptions());
  btn.disabled = false;
  if (!res.ok) {
    Toast.show(res.error || 'Dry run failed', { type: 'error' });
    return;
  }
  dryRunRows = res.rows;
  dryRunFilter = 'all';
  document.querySelectorAll('.dry-run-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  const c = res.counts;
  document.getElementById('dryRunSummary').innerHTML = `
    <span class="drs-matched">✓ ${c.matched} ready</span>
    <span class="drs-already_embedded">ⓘ ${c.already_embedded} already embedded</span>
    <span class="drs-missing_image">⚠ ${c.missing_image} image${c.missing_image === 1 ? '' : 's'} missing</span>
    <span class="drs-missing_metadata">⚠ ${c.missing_metadata} metadata record${c.missing_metadata === 1 ? '' : 's'} unmatched</span>
    <span class="drs-unsupported">✕ ${c.unsupported} unsupported file${c.unsupported === 1 ? '' : 's'}</span>`;
  document.getElementById('dryRunPanel').style.display = 'block';
  renderDryRunRows();
  Toast.show(`Dry run complete — ${c.matched} of ${res.total} ready to embed`, { type: c.matched === res.total ? 'success' : 'info' });
});

document.getElementById('btnStartEmbed').addEventListener('click', async () => {
  const columns = {
    filename: document.getElementById('colFilename').value || null,
    title: document.getElementById('colTitle').value || null,
    keywords: document.getElementById('colKeywords').value || null,
    description: document.getElementById('colDescription').value || null,
  };
  const options = {
    subfolders: document.getElementById('optSubfolders').checked,
    match_ext_only: document.getElementById('optMatchExt').checked,
    remove_progressive: document.getElementById('optRmProgressive').checked,
    // Remove copyright fields defaults on -- no longer a separate UI
    // toggle (dropped to match the original app's exact 4-toggle
    // layout), but the safe-by-default behavior is kept as-is.
    remove_copyright: true,
    replace_filename: document.getElementById('optReplaceFilename').checked,
    concurrency: EMBED_CONCURRENCY,
  };
  clearEmbedLog();
  document.getElementById('dryRunPanel').style.display = 'none';
  embedProgressWrap.style.display = 'block';
  embedProgressBar.style.width = '0%';
  document.getElementById('btnStartEmbed').disabled = true;
  const res = await pywebview.api.start_embed(currentFolder, columns, options);
  if (!res.ok) {
    embedCounts.textContent = res.error || 'Could not start embed.';
    document.getElementById('btnStartEmbed').disabled = false;
  }
});

document.getElementById('btnClearEmbedLog').addEventListener('click', () => {
  clearEmbedLog();
});

BackendEvents.on('embed_log', (p) => {
  const prefix = { ok: '✓', warn: '⚠', error: '✗', done: '●' }[p.level] || '·';
  pendingLogLines.push(`${prefix}  ${p.msg}\n`);
  scheduleLogFlush();
});

BackendEvents.on('embed_progress', (p) => {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  embedProgressBar.style.width = pct + '%';
  embedCounts.textContent = `${p.ok} succeeded · ${p.errors} failed · ${p.skipped} not found  (${p.done}/${p.total})`;
});

BackendEvents.on('embed_completed', (p) => {
  document.getElementById('btnStartEmbed').disabled = false;
});

// ---- Auto-load the batch that just finished on Meta Generator ----
// v0.8.4: previously only reachable through a separate popup window
// (?popup=embed&auto=1). Per Hasib's "no pop-up" request, the Embed
// button on Meta Generator now switches to this same in-app page and
// calls this directly (see app.js's btnEmbedBatch handler + nav.js's
// goToPage). Exposed on window so app.js can call it without a module
// system. The ?popup=embed&auto=1 URL path (still used by
// open_embed_popup in bridge.py, currently unused by the frontend) is
// left working too, in case that mechanism is wanted again later.
async function autoLoadEmbedBatch() {
  const res = await pywebview.api.auto_load_embed();
  if (!res.ok) {
    csvStatus.textContent = res.error || 'Could not auto-load the last batch.';
    return false;
  }
  currentHeaders = res.headers;
  csvStatus.textContent = `✓ ${res.rows} rows loaded (auto-loaded)`;
  fillColumnSelects(res.headers, res.guessed_columns);
  if (res.folder) {
    currentFolder = res.folder;
    folderStatus.textContent = `✓ ${res.folder}`;
  }
  refreshMatchCount();
  return true;
}
window.autoLoadEmbedBatch = autoLoadEmbedBatch;

const _embedParams = new URLSearchParams(location.search);
if (_embedParams.get('popup') === 'embed' && _embedParams.get('auto')) {
  onPywebviewReady(autoLoadEmbedBatch);
}
