// Batch (formerly "Automation Queue -- BETA", v0.1.0). Renders and
// drives the Batch queue UI: add/remove/reorder/duplicate folders,
// per-folder preset + settings editing (plus a Universal Preset that
// applies one set of settings to every folder at once), persistence,
// and the real sequential processing engine (Start/Pause/Stop) with a
// live progress monitor.
//
// v0.9.6: embedded into the main window as a normal nav page --
// previously this only ever rendered inside a separate popup window
// opened via a Dashboard button; that popup mechanism (and this
// button's separate click handler) is gone now. The button below is
// a plain [data-page="automation"] quick-btn, wired by nav.js exactly
// like every other Dashboard shortcut.

const automationDropzone = document.getElementById('automationDropzone');
const automationQueueList = document.getElementById('automationQueueList');
const automationEmptyState = document.getElementById('automationEmptyState');
const automationQueueCount = document.getElementById('automationQueueCount');
const btnAddFolder = document.getElementById('btnAddFolder');
const jobTemplate = document.getElementById('automationJobTemplate');
const btnStartQueue = document.getElementById('btnStartQueue');
const btnPauseQueue = document.getElementById('btnPauseQueue');
const btnStopQueue = document.getElementById('btnStopQueue');
const progressBanner = document.getElementById('automationProgressBanner');
const progressFill = document.getElementById('automationProgressFill');
const currentFolderEl = document.getElementById('automationCurrentFolder');
const currentStepEl = document.getElementById('automationCurrentStep');
const overallCountEl = document.getElementById('automationOverallCount');
const timeInfoEl = document.getElementById('automationTimeInfo');
const resumeBanner = document.getElementById('automationResumeBanner');
const resumeText = document.getElementById('automationResumeText');
const btnAutomationResume = document.getElementById('btnAutomationResume');
const btnAutomationDiscard = document.getElementById('btnAutomationDiscard');
const btnDryRun = document.getElementById('btnAutomationDryRun');
const dryRunModal = document.getElementById('automationDryRunModal');
const dryRunBody = document.getElementById('automationDryRunBody');
const btnCloseDryRun = document.getElementById('btnCloseDryRun');
const reportModal = document.getElementById('automationReportModal');
const reportTitle = document.getElementById('automationReportTitle');
const reportBody = document.getElementById('automationReportBody');
const btnCloseReport = document.getElementById('btnCloseReport');

// Guard against a future page variant that omits this section --
// keeps this file a no-op instead of throwing on null elements if so.
if (automationQueueList) {
  const STATUS_LABELS = {
    waiting: 'Waiting', running: 'Running', done: 'Done',
    error: 'Error', stopped: 'Stopped',
  };

  let currentJobs = [];       // last-rendered state, kept for the preset modal + drag reorder
  let dragSourceId = null;
  let lastShownReportAt = null; // guards against re-popping the same completion report on every poll

  function fileTypeLabel(job) {
    if (!job.exists) return 'Folder not found';
    if (job.file_count === 0) return 'No supported files';
    return `${job.file_count} files · ${job.file_type}`;
  }

  function fmtDuration(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return null;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [h, m, sec].map((v, i) => (i === 0 && v === 0) ? null : String(v).padStart(2, '0'))
      .filter(v => v !== null).join(':');
  }

  function renderQueue(state) {
    currentJobs = state.jobs || [];
    automationQueueList.querySelectorAll('.automation-job').forEach(el => el.remove());
    automationQueueCount.textContent = currentJobs.length
      ? `${currentJobs.length} folder${currentJobs.length === 1 ? '' : 's'}`
      : '';
    automationEmptyState.classList.toggle('visible', currentJobs.length === 0);

    currentJobs.forEach((job, i) => {
      const node = jobTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.jobId = job.id;
      node.querySelector('.automation-job-num').textContent =
        String(i + 1).padStart(2, '0');
      node.querySelector('.automation-job-name').textContent = job.name;
      node.querySelector('.automation-job-meta').textContent = job.status === 'running'
        ? `${job.current_step || 'Processing'} — ${job.progress.done + job.progress.failed}/${job.progress.total} files`
        : `${fileTypeLabel(job)} · Preset: ${job.preset_name}`;

      const statusEl = node.querySelector('.automation-job-status');
      const statusKey = job.exists ? job.status : 'not-found';
      statusEl.textContent = job.exists ? STATUS_LABELS[job.status] || job.status : 'Not found';
      statusEl.classList.add(`status-${statusKey}`);

      node.querySelector('.automation-job-preset').addEventListener('click', () => openPresetModal(job.id));
      node.querySelector('.automation-job-duplicate').addEventListener('click', async () => {
        await pywebview.api.automation_duplicate_folder(job.id);
        refresh();
      });
      node.querySelector('.automation-job-remove').addEventListener('click', async () => {
        const res = await pywebview.api.automation_remove_folder(job.id);
        if (!res.ok) Toast.show(res.error, { type: 'error' });
        refresh();
      });

      // Native HTML5 drag reorder -- simplest reliable option for a
      // short, always-visible list like this queue.
      node.addEventListener('dragstart', () => {
        dragSourceId = job.id;
        node.classList.add('dragging');
      });
      node.addEventListener('dragend', () => node.classList.remove('dragging'));
      node.addEventListener('dragover', (e) => {
        e.preventDefault();
        node.classList.add('drop-target');
      });
      node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
      node.addEventListener('drop', async (e) => {
        e.preventDefault();
        node.classList.remove('drop-target');
        if (!dragSourceId || dragSourceId === job.id) return;
        const ids = currentJobs.map(j => j.id);
        const from = ids.indexOf(dragSourceId);
        const to = ids.indexOf(job.id);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        const res = await pywebview.api.automation_reorder(ids);
        if (!res.ok) Toast.show(res.error, { type: 'error' });
        refresh();
      });

      automationQueueList.appendChild(node);
    });
  }

  function renderController(state) {
    const controller = state.controller || {};
    const running = !!controller.running;
    btnStartQueue.disabled = running;
    btnPauseQueue.disabled = !running;
    btnStopQueue.disabled = !running;
    btnPauseQueue.textContent = controller.paused ? '▶ Resume' : '⏸ Pause';

    progressBanner.hidden = !running;
    if (!running) {
      showReportIfNew(controller);
      return;
    }

    const job = currentJobs.find(j => j.id === controller.current_job_id);
    const doneJobs = currentJobs.filter(j => j.status === 'done').length;
    currentFolderEl.textContent = job ? `📁 ${job.name}` : '';
    currentStepEl.textContent = job ? (job.current_step || '') : '';

    const pct = job && job.progress.total
      ? Math.round(((job.progress.done + job.progress.failed) / job.progress.total) * 100)
      : 0;
    progressFill.style.width = `${pct}%`;

    overallCountEl.textContent = `Folder ${Math.min(doneJobs + 1, currentJobs.length)} / ${currentJobs.length} · Overall ${doneJobs}/${currentJobs.length} complete`;

    const elapsed = controller.queue_started_at ? (Date.now() / 1000 - controller.queue_started_at) : null;
    const eta = controller.estimated_remaining_seconds;
    const elapsedStr = fmtDuration(elapsed);
    const etaStr = eta == null ? 'Calculating estimate…' : `~${fmtDuration(eta)} remaining`;
    timeInfoEl.textContent = controller.paused
      ? 'Paused'
      : `Elapsed ${elapsedStr || '0:00'} · ${etaStr}`;
  }

  function showReportIfNew(controller) {
    const report = controller.last_report;
    if (!report || controller.queue_finished_at == null) return;
    if (lastShownReportAt === controller.queue_finished_at) return; // already shown for this run
    lastShownReportAt = controller.queue_finished_at;

    reportTitle.textContent = report.stopped_early ? 'Automation Stopped' : 'Automation Complete';
    const row = (label, value) => `<div class="dry-run-row" style="justify-content:space-between;"><span>${label}</span><span>${value}</span></div>`;
    const lines = [];
    lines.push(row('Folders', `${report.folders_completed} / ${report.folders_total}`));
    lines.push(row('Files', report.total_files));
    lines.push(row('Successful', report.successful));
    lines.push(row('Failed', report.failed));
    lines.push(row('Total time', fmtDuration(report.total_seconds) || '—'));
    lines.push(row('CSV', `${report.csv_generated} generated`));
    if (report.embed_attempted > 0) {
      lines.push(row('Embedding', `${report.embed_success} successful${report.embed_errors ? `, ${report.embed_errors} with errors` : ''}`));
    }
    reportBody.innerHTML = lines.join('');
    reportModal.hidden = false;
  }

  btnCloseReport.addEventListener('click', () => { reportModal.hidden = true; });
  reportModal.addEventListener('click', (e) => { if (e.target === reportModal) reportModal.hidden = true; });

  function renderState(state) {
    renderQueue(state);
    renderController(state);
  }

  async function refresh() {
    const state = await pywebview.api.automation_get_state();
    if (state.ok) renderState(state);
  }

  btnStartQueue.addEventListener('click', async () => {
    const res = await pywebview.api.automation_start_queue();
    if (!res.ok) Toast.show(res.error, { type: 'error' });
    refresh();
  });
  btnPauseQueue.addEventListener('click', async () => {
    const res = await pywebview.api.automation_pause_queue();
    if (!res.ok) Toast.show(res.error, { type: 'error' });
    refresh();
  });
  btnStopQueue.addEventListener('click', async () => {
    const res = await pywebview.api.automation_stop_queue();
    if (!res.ok) Toast.show(res.error, { type: 'error' });
    refresh();
  });

  // Real-time push updates while the queue is processing -- emitted by
  // job_controller.py on every state change (folder start/progress
  // tick/finish), not polled from this side.
  BackendEvents.on('automation_state', renderState);

  // ---- Add folder (Browse button + dropzone click) ----
  async function browseAndAdd() {
    const res = await pywebview.api.automation_browse_folder();
    if (res.cancelled) return;
    if (!res.ok) { Toast.show(res.error, { type: 'error' }); return; }
    Animate.dropSuccess(automationDropzone);
    refresh();
  }
  if (btnAddFolder) btnAddFolder.addEventListener('click', browseAndAdd);
  if (automationDropzone) {
    automationDropzone.addEventListener('click', (e) => {
      // Don't double-trigger when the inner "+ Add Folder" button was
      // the actual click target.
      if (e.target === btnAddFolder) return;
      browseAndAdd();
    });
  }

  // Real drag-and-drop visual feedback -- the actual filesystem-path
  // drop handling happens on the Python side (bridge.py's
  // open_automation_window, using pywebview's DOM event API), which
  // then emits automation_folders_dropped below. This listener only
  // adds/removes the highlight class; it never reads dataTransfer
  // itself (browser-side folder path retrieval isn't real, same
  // caveat as the rest of the app's drag-and-drop).
  if (automationDropzone) {
    automationDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      automationDropzone.classList.add('drag-active');
    });
    automationDropzone.addEventListener('dragleave', () => automationDropzone.classList.remove('drag-active'));
    automationDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      automationDropzone.classList.remove('drag-active');
    });
  }

  BackendEvents.on('automation_folders_dropped', (res) => {
    automationDropzone.classList.remove('drag-active');
    if (res && res.ok) {
      Animate.dropSuccess(automationDropzone);
      const failed = (res.results || []).filter(r => !r.ok);
      failed.forEach(r => Toast.show(r.error, { type: 'error' }));
    }
    refresh();
  });

  // ---- Per-folder preset / settings modal (spec item 8) ----
  const presetModal = document.getElementById('automationPresetModal');
  const presetFolderName = document.getElementById('automationPresetFolderName');
  const presetSelect = document.getElementById('automationPresetSelect');
  const optTitleChars = document.getElementById('automationOptTitleChars');
  const optIncludeDesc = document.getElementById('automationOptIncludeDesc');
  const optDescChars = document.getElementById('automationOptDescChars');
  const optKwCount = document.getElementById('automationOptKwCount');
  const optCustomPrompt = document.getElementById('automationOptCustomPrompt');
  const optAutoCsv = document.getElementById('automationOptAutoCsv');
  const optAutoEmbed = document.getElementById('automationOptAutoEmbed');
  const btnSaveSettings = document.getElementById('btnAutomationSaveSettings');
  const btnCancelSettings = document.getElementById('btnAutomationCancelSettings');
  let editingJobId = null;

  async function openPresetModal(jobId) {
    const job = currentJobs.find(j => j.id === jobId);
    if (!job) return;
    editingJobId = jobId;

    const presets = await pywebview.api.automation_get_presets();
    presetSelect.innerHTML = '';
    [...presets.builtin, ...presets.custom].forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      presetSelect.appendChild(opt);
    });
    presetSelect.value = job.preset_name;

    presetFolderName.textContent = `${job.name} — ${fileTypeLabel(job)}`;
    optTitleChars.value = job.options.title_chars;
    optIncludeDesc.checked = !!job.options.include_desc;
    optDescChars.value = job.options.desc_chars;
    optKwCount.value = job.options.kw_count;
    optCustomPrompt.value = job.options.custom || '';
    optAutoCsv.checked = !!job.options.auto_download_csv;
    optAutoEmbed.checked = !!job.options.auto_embed;

    presetModal.hidden = false;
  }

  presetSelect.addEventListener('change', async () => {
    // Selecting a preset re-populates the fields below with that
    // preset's starting values (spec item 9) -- doesn't save until
    // "Save" is clicked, so switching presets is freely reversible.
    const res = await pywebview.api.automation_apply_preset(editingJobId, presetSelect.value);
    if (res.ok) {
      const job = res.job;
      optTitleChars.value = job.options.title_chars;
      optIncludeDesc.checked = !!job.options.include_desc;
      optDescChars.value = job.options.desc_chars;
      optKwCount.value = job.options.kw_count;
      optCustomPrompt.value = job.options.custom || '';
      optAutoCsv.checked = !!job.options.auto_download_csv;
      optAutoEmbed.checked = !!job.options.auto_embed;
    }
  });

  btnSaveSettings.addEventListener('click', async () => {
    const options = {
      title_chars: parseInt(optTitleChars.value, 10) || 130,
      include_desc: optIncludeDesc.checked,
      desc_chars: parseInt(optDescChars.value, 10) || 200,
      kw_count: parseInt(optKwCount.value, 10) || 49,
      custom: optCustomPrompt.value,
      auto_download_csv: optAutoCsv.checked,
      auto_embed: optAutoEmbed.checked,
    };
    const res = await pywebview.api.automation_update_job_options(editingJobId, options);
    if (!res.ok) Toast.show(res.error, { type: 'error' });
    presetModal.hidden = true;
    refresh();
  });

  btnCancelSettings.addEventListener('click', () => { presetModal.hidden = true; });
  presetModal.addEventListener('click', (e) => {
    if (e.target === presetModal) presetModal.hidden = true; // click outside the panel = cancel
  });

  // ---- Universal Preset (v0.9.6) ----
  // Same fields as the per-folder modal above, but "Apply to All
  // Folders" pushes them onto every folder currently in the queue in
  // one shot via automation_apply_universal_preset, instead of just
  // the one folder being edited. Individual folders can still be
  // re-customized afterward through the per-folder ⚙ button above.
  const btnUniversalPreset = document.getElementById('btnUniversalPreset');
  const universalModal = document.getElementById('automationUniversalModal');
  const uniPresetSelect = document.getElementById('automationUniversalPresetSelect');
  const uniTitleChars = document.getElementById('automationUniTitleChars');
  const uniIncludeDesc = document.getElementById('automationUniIncludeDesc');
  const uniDescChars = document.getElementById('automationUniDescChars');
  const uniKwCount = document.getElementById('automationUniKwCount');
  const uniCustomPrompt = document.getElementById('automationUniCustomPrompt');
  const uniAutoCsv = document.getElementById('automationUniAutoCsv');
  const uniAutoEmbed = document.getElementById('automationUniAutoEmbed');
  const btnUniversalApply = document.getElementById('btnAutomationUniversalApply');
  const btnUniversalCancel = document.getElementById('btnAutomationUniversalCancel');

  function currentUniversalOptions() {
    return {
      title_chars: parseInt(uniTitleChars.value, 10) || 130,
      include_desc: uniIncludeDesc.checked,
      desc_chars: parseInt(uniDescChars.value, 10) || 200,
      kw_count: parseInt(uniKwCount.value, 10) || 49,
      custom: uniCustomPrompt.value,
      auto_download_csv: uniAutoCsv.checked,
      auto_embed: uniAutoEmbed.checked,
    };
  }

  if (btnUniversalPreset) {
    btnUniversalPreset.addEventListener('click', async () => {
      if (!currentJobs.length) {
        Toast.show('Add at least one folder to the queue first.', { type: 'error' });
        return;
      }
      const presets = await pywebview.api.automation_get_presets();
      uniPresetSelect.innerHTML = '';
      [...presets.builtin, ...presets.custom].forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        uniPresetSelect.appendChild(opt);
      });
      // Start the form from the first queued folder's current values --
      // just a sensible starting point, not a saved preference.
      const seed = currentJobs[0];
      uniPresetSelect.value = seed.preset_name;
      uniTitleChars.value = seed.options.title_chars;
      uniIncludeDesc.checked = !!seed.options.include_desc;
      uniDescChars.value = seed.options.desc_chars;
      uniKwCount.value = seed.options.kw_count;
      uniCustomPrompt.value = seed.options.custom || '';
      uniAutoCsv.checked = !!seed.options.auto_download_csv;
      uniAutoEmbed.checked = !!seed.options.auto_embed;
      universalModal.hidden = false;
    });
  }

  if (uniPresetSelect) {
    uniPresetSelect.addEventListener('change', async () => {
      // Same behavior as the per-folder modal's preset dropdown: pick
      // a starting point, don't apply anything until Apply is clicked.
      const presets = await pywebview.api.automation_get_presets();
      const all = [...presets.builtin, ...presets.custom];
      if (!all.includes(uniPresetSelect.value)) return;
      // Re-use the per-folder apply-to-one-job endpoint against the
      // first job just to read that preset's real option values back
      // (presets live server-side; there's no separate "peek" call).
      if (!currentJobs.length) return;
      const res = await pywebview.api.automation_apply_preset(currentJobs[0].id, uniPresetSelect.value);
      if (res.ok) {
        const job = res.job;
        uniTitleChars.value = job.options.title_chars;
        uniIncludeDesc.checked = !!job.options.include_desc;
        uniDescChars.value = job.options.desc_chars;
        uniKwCount.value = job.options.kw_count;
        uniCustomPrompt.value = job.options.custom || '';
        uniAutoCsv.checked = !!job.options.auto_download_csv;
        uniAutoEmbed.checked = !!job.options.auto_embed;
      }
    });
  }

  if (btnUniversalApply) {
    btnUniversalApply.addEventListener('click', async () => {
      const res = await pywebview.api.automation_apply_universal_preset(currentUniversalOptions());
      universalModal.hidden = true;
      if (!res.ok) {
        Toast.show(res.error || 'Could not apply Universal Preset.', { type: 'error' });
        return;
      }
      const n = (res.applied || []).length;
      const skipped = (res.skipped || []).length;
      Toast.show(
        skipped
          ? `Applied to ${n} folder${n === 1 ? '' : 's'} — ${skipped} skipped (currently processing).`
          : `Applied to ${n} folder${n === 1 ? '' : 's'}.`,
        { type: 'success' }
      );
      refresh();
    });
  }

  if (btnUniversalCancel) btnUniversalCancel.addEventListener('click', () => { universalModal.hidden = true; });
  if (universalModal) {
    universalModal.addEventListener('click', (e) => {
      if (e.target === universalModal) universalModal.hidden = true; // click outside the panel = cancel
    });
  }

  // ---- Resumable-queue check (spec item 19) ----
  // Read-only check on load -- doesn't touch the queue until the user
  // explicitly picks Resume or Discard, matching the spec's prompt-
  // then-decide flow.
  async function checkResumable() {
    const res = await pywebview.api.automation_check_resumable();
    if (!res.ok || !res.resumable) return;
    const jobs = res.data.jobs || [];
    const waiting = jobs.filter(j => j.status !== 'done').length;
    resumeText.textContent = `Unfinished Automation Queue found — ${waiting} folder${waiting === 1 ? '' : 's'} not yet complete.`;
    resumeBanner.hidden = false;
  }

  btnAutomationResume.addEventListener('click', async () => {
    const res = await pywebview.api.automation_load_resumable();
    resumeBanner.hidden = true;
    if (!res.ok) { Toast.show(res.error, { type: 'error' }); return; }
    Toast.show('Queue restored — already-completed folders were skipped.', { type: 'success' });
    refresh();
  });
  btnAutomationDiscard.addEventListener('click', async () => {
    await pywebview.api.automation_discard_resumable();
    resumeBanner.hidden = true;
  });

  // ---- Dry Run (spec item 20) ----
  const ISSUE_ICON = { ok: '✓', warn: '⚠' };
  btnDryRun.addEventListener('click', async () => {
    const res = await pywebview.api.automation_dry_run();
    if (!res.ok) { Toast.show(res.error || 'Dry run failed.', { type: 'error' }); return; }

    const lines = [];
    lines.push(`<p class="dry-run-summary">${res.total_folders} folder${res.total_folders === 1 ? '' : 's'} · ${res.total_files} file${res.total_files === 1 ? '' : 's'} detected</p>`);
    res.folders.forEach(f => {
      const icon = f.ok ? ISSUE_ICON.ok : ISSUE_ICON.warn;
      const detail = f.ok ? `${f.file_count} files` : f.issues.join(' ');
      lines.push(`<div class="dry-run-row"><span class="dry-run-icon">${icon}</span><span>${f.name} — ${detail}</span></div>`);
    });
    lines.push(`<div class="dry-run-row"><span class="dry-run-icon">${res.api_ready ? '✓' : '⚠'}</span><span>API configuration ${res.api_ready ? 'ready' : 'not ready — add an active key in API Manager'}</span></div>`);
    if (res.embed_requested) {
      lines.push(`<div class="dry-run-row"><span class="dry-run-icon">${res.exiftool_ready ? '✓' : '⚠'}</span><span>Embedding tool ${res.exiftool_ready ? 'available' : 'not found — Auto Embed folders will fail'}</span></div>`);
    }
    const ready = res.all_folders_ok && res.api_ready && (!res.embed_requested || res.exiftool_ready);
    lines.push(`<p class="dry-run-summary" style="margin-top:10px;">${ready ? '✓ Ready to process.' : '⚠ Fix the issues above before starting the queue.'}</p>`);

    dryRunBody.innerHTML = lines.join('');
    dryRunModal.hidden = false;
  });
  btnCloseDryRun.addEventListener('click', () => { dryRunModal.hidden = true; });
  dryRunModal.addEventListener('click', (e) => { if (e.target === dryRunModal) dryRunModal.hidden = true; });

  onPywebviewReady(() => { refresh(); checkResumable(); });
}
