const apiTabs = document.getElementById('apiTabs');
const apiKeyList = document.getElementById('apiKeyList');
const keyCardTemplate = document.getElementById('keyCardTemplate');

let providersCache = [];
let activeProvider = null;

// v0.9.x (Part 21): validate_key_live() now returns immediately with a
// request_id and delivers the real ok/message pair later as a
// "key_validated" event (see bridge.py) -- this wraps that back into a
// Promise so call sites below can keep the exact same
// `const res = await requestValidateKey(...)` shape they had when the
// call was synchronous. pendingValidations maps request_id -> resolve,
// one shared listener handles every in-flight validation regardless of
// which key/button triggered it.
const pendingValidations = new Map();
BackendEvents.on('key_validated', (p) => {
  const resolve = pendingValidations.get(p.request_id);
  if (!resolve) return;
  pendingValidations.delete(p.request_id);
  resolve({ ok: p.ok, message: p.message });
});
function requestValidateKey(provider, key) {
  return new Promise(async (resolve) => {
    const started = await pywebview.api.validate_key_live(provider, key);
    if (!started.request_id) { resolve({ ok: false, message: 'Could not start validation' }); return; }
    pendingValidations.set(started.request_id, resolve);
  });
}

// v0.9.4.1: single module-level Test All listener slot, keyed by the
// batch's own request_id -- see the Test All click handler below for
// why (item 1 of the v0.9.4.1 maintenance fixes: stale/unrelated
// key_validated events were corrupting the progress counter).
let activeTestAll = null; // { requestId, onResult }
function stopActiveTestAll() {
  if (activeTestAll) {
    BackendEvents.off('key_validated', activeTestAll.onResult);
    activeTestAll = null;
  }
}

// v0.9.4 (item 15): registered once at module scope, not inside
// renderProvider() (which re-runs on every tab switch/loadProviders
// call) -- a per-render registration with no matching unsubscribe
// would leave a growing pile of stale listeners, each still firing on
// every future Test All completion.
BackendEvents.on('test_all_completed', (res) => {
  if (res.provider !== activeProvider) return;
  // v0.9.4.1: only react to this event if it actually belongs to the
  // Test All run we're currently tracking -- a completion event from
  // an already-superseded batch (e.g. the person navigated away and
  // back, or fired a second run before this one's tail event arrived)
  // must not touch the button state for whatever's running now.
  if (activeTestAll && !BackendEvents.matchesRequest(res, activeTestAll.requestId)) return;
  stopActiveTestAll();
  const btn = document.getElementById('btnTestAll');
  if (btn) { btn.disabled = false; btn.textContent = '🧪 Test All'; }
  Toast.show(`Tested ${res.total} key(s) for ${res.provider}`, { type: 'info' });
  loadProviders();
});

async function loadProviders() {
  const res = await pywebview.api.get_provider_summary();
  providersCache = res.providers;
  if (!activeProvider) activeProvider = providersCache[0]?.provider;
  renderTabs();
  renderProvider();
}

function renderTabs() {
  apiTabs.innerHTML = providersCache.map(p =>
    `<button class="api-tab ${p.provider === activeProvider ? 'active' : ''}" data-provider="${p.provider}">
       ${p.provider} <span class="api-tab-count">●${p.active_count}</span>
     </button>`
  ).join('');
  apiTabs.querySelectorAll('.api-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeProvider = btn.dataset.provider; renderTabs(); renderProvider(); });
  });
}

function renderProvider() {
  const p = providersCache.find(x => x.provider === activeProvider);
  if (!p) return;

  document.getElementById('apiProviderName').textContent = p.provider;
  document.getElementById('apiGetKeyBtn').onclick = () => window.open(p.key_url, '_blank');
  document.getElementById('applyAllCount').textContent = p.keys.length;

  const modelSel = document.getElementById('apiModelSelect');
  modelSel.innerHTML = p.models.map(([label, id]) => `<option value="${id}">${label}</option>`).join('');
  modelSel.value = p.current_model;
  modelSel.onchange = async () => { await pywebview.api.set_provider_model(p.provider, modelSel.value); };

  document.getElementById('btnApplyModelAll').onclick = async () => {
    await pywebview.api.set_provider_model(p.provider, modelSel.value);
    loadProviders();
  };

  document.getElementById('apiSaveKeyBtn').onclick = async () => {
    const input = document.getElementById('apiNewKeyInput');
    const val = input.value.trim();
    if (!val) return;
    const res = await pywebview.api.add_api_key(p.provider, val);
    const status = document.getElementById('apiKeyValidateStatus');
    if (!res.ok) { status.textContent = res.error || 'Could not save.'; return; }
    input.value = ''; status.textContent = '';
    loadProviders();
  };

  // Live validation on blur -- informational only, never blocks Save
  // (matches the original's FocusOut-triggered check).
  document.getElementById('apiNewKeyInput').onblur = async (e) => {
    const val = e.target.value.trim();
    const status = document.getElementById('apiKeyValidateStatus');
    if (val.length < 8) { status.textContent = ''; return; }
    status.textContent = '⟳ Checking…';
    const res = await requestValidateKey(p.provider, val);
    status.textContent = res.ok ? '✓ Valid' : `✗ ${res.message || 'Invalid'}`;
  };

  document.getElementById('btnActivateAll').onclick = async () => {
    await pywebview.api.set_all_keys_active(p.provider, true); loadProviders();
  };
  document.getElementById('btnDeactivateAll').onclick = async () => {
    await pywebview.api.set_all_keys_active(p.provider, false); loadProviders();
  };

  // v0.9.4.1 fix: Test All's progress counter used to increment on
  // *any* key_validated event app-wide, with no check against which
  // batch it actually belonged to -- an unrelated single-key Test
  // click (or a still-draining previous Test All run) would silently
  // corrupt the counter. The backend already tags every key_validated
  // event from test_all_keys() with that batch's own request_id (see
  // bridge.py); this now actually checks it, using the same
  // request/operation id mechanism the single-key Test button already
  // relies on via pendingValidations, rather than adding a second
  // event system.
  //
  // Module-level (not per-click) so starting a new Test All run always
  // tears down any previous run's still-attached listener first --
  // covers the "switched tabs / re-triggered while one was still
  // finishing" case as well as a literal second click.
  const testAllBtn = document.getElementById('btnTestAll');
  testAllBtn.onclick = async () => {
    if (!p.keys.length) return;
    stopActiveTestAll();
    testAllBtn.disabled = true;
    testAllBtn.textContent = `⟳ Testing 0/${p.keys.length}…`;
    const started = await pywebview.api.test_all_keys(p.provider);
    if (!started.ok || !started.request_id) {
      testAllBtn.disabled = false;
      testAllBtn.textContent = '🧪 Test All';
      return;
    }
    const requestId = started.request_id;
    const total = started.total;
    let done = 0;
    const onResult = (payload) => {
      if (!BackendEvents.matchesRequest(payload, requestId)) return; // not this batch -- ignore
      done = Math.min(done + 1, total); // never exceed total, even on a stray duplicate
      testAllBtn.textContent = `⟳ Testing ${done}/${total}…`;
      if (done >= total) stopActiveTestAll();
    };
    activeTestAll = { requestId, onResult };
    BackendEvents.on('key_validated', onResult);
  };
  document.getElementById('btnActivateValid').onclick = async () => {
    const untested = p.keys.filter(k => !k.last_test).length;
    const res = await pywebview.api.activate_valid_keys(p.provider);
    if (res.ok) {
      Toast.show(`${res.changed} key(s) updated${untested ? ` — ${untested} untested key(s) left as-is` : ''}`, { type: 'success' });
      loadProviders();
    }
  };

  apiKeyList.innerHTML = '';
  if (!p.keys.length) {
    apiKeyList.innerHTML = '<div class="hint-text">No keys saved yet.</div>';
    return;
  }
  p.keys.forEach((k, idx) => {
    const card = keyCardTemplate.content.firstElementChild.cloneNode(true);
    card.classList.toggle('key-card-active', k.active);
    const maskedEl = card.querySelector('.key-masked');
    maskedEl.textContent = k.masked;
    card.querySelector('.key-active-pill').style.display = k.active ? '' : 'none';

    // v0.9.4 (item 15): nickname, click-to-rename (same contenteditable
    // pattern P2P's prompt cards already use, rather than a jarring
    // native prompt() dialog that can't be styled to match the rest of
    // the app).
    const nickEl = card.querySelector('.key-nickname');
    nickEl.textContent = k.nickname || '(unnamed key)';
    nickEl.classList.toggle('key-nickname-empty', !k.nickname);
    nickEl.addEventListener('click', () => {
      nickEl.setAttribute('contenteditable', 'true');
      nickEl.textContent = k.nickname || '';
      nickEl.focus();
      document.execCommand('selectAll', false, null);
    });
    nickEl.addEventListener('blur', async () => {
      nickEl.setAttribute('contenteditable', 'false');
      const val = nickEl.textContent.trim();
      await pywebview.api.set_key_nickname(p.provider, idx, val);
      loadProviders();
    });
    nickEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nickEl.blur(); }
      if (e.key === 'Escape') { nickEl.textContent = k.nickname || '(unnamed key)'; nickEl.blur(); }
    });

    // v0.9.4 (item 15): status badge -- real, persisted last_test
    // result (see settings.py's record_key_test), never a color-only
    // indicator. A key that's never been tested honestly shows
    // UNKNOWN rather than a fabricated default.
    setStatusBadge(card.querySelector('.key-status-badge'), k.last_test);
    const metaEl = card.querySelector('.key-card-meta');
    metaEl.textContent = k.last_test ? `Last tested ${relativeTime(k.last_test.at)} — ${k.last_test.message}` : 'Never tested';

    let shown = false;
    card.querySelector('.key-eye-btn').addEventListener('click', () => {
      shown = !shown;
      maskedEl.textContent = shown ? k.key : k.masked;
    });
    card.querySelector('.key-copy-btn').addEventListener('click', async (e) => {
      await copyText(k.key);
      flashCopied(e.currentTarget);
    });
    const testBtn = card.querySelector('.key-test-btn');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = '⟳…';
      const res = await requestValidateKey(p.provider, k.key);
      testBtn.disabled = false;
      testBtn.textContent = res.ok ? '✓ OK' : '✗ Bad';
      // Reflects immediately rather than waiting for a manual refresh
      // -- record_key_test already persisted this server-side by the
      // time requestValidateKey's promise resolves (bridge.py records
      // it before emitting key_validated).
      setStatusBadge(card.querySelector('.key-status-badge'),
        { status: res.ok ? 'valid' : (res.message || '').startsWith('Invalid key') ? 'invalid' : 'error', message: res.message, at: Date.now() / 1000 });
      metaEl.textContent = `Last tested just now — ${res.message}`;
    });

    const toggleBtn = card.querySelector('.key-toggle-btn');
    toggleBtn.textContent = k.active ? 'Deactivate' : 'Activate';
    toggleBtn.addEventListener('click', async () => {
      await pywebview.api.set_key_active(p.provider, idx, !k.active);
      loadProviders();
    });

    card.querySelector('.key-delete-btn').addEventListener('click', async () => {
      await pywebview.api.delete_api_key(p.provider, idx);
      loadProviders();
    });

    apiKeyList.appendChild(card);
  });
}

// v0.9.4 (item 15): shared status-badge renderer -- text label always
// present (never color-only, per the spec), color is a secondary cue.
function setStatusBadge(el, lastTest) {
  const status = lastTest ? lastTest.status : 'unknown';
  const labels = { valid: 'VALID', invalid: 'INVALID', error: 'ERROR', unknown: 'UNKNOWN' };
  el.textContent = labels[status] || 'UNKNOWN';
  el.className = `key-status-badge key-status-${status}`;
}

function relativeTime(unixSeconds) {
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

document.querySelector('[data-page="settings"]').addEventListener('click', loadProviders);
onPywebviewReady(loadProviders);

document.getElementById('btnModelSettings').addEventListener('click', openModelSettingsPanel);

// v0.9.5: model enable/disable panel -- "organized in order and
// modern way" per the request: a section per provider (in the same
// order as the provider tabs), each listing its full model set as
// toggle switches, reusing the app's existing .switch control rather
// than inventing a new checkbox style. Built the same way confirm.js
// builds its modal (a backdrop + dialog appended to <body>, removed on
// close) for visual consistency with the rest of the app, since this
// needed a richer content area than confirm.js's fixed title/message/
// two-button shape supports.
async function openModelSettingsPanel() {
  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-backdrop model-settings-backdrop';
  backdrop.innerHTML = `
    <div class="confirm-dialog model-settings-dialog" role="dialog" aria-modal="true">
      <div class="model-settings-header">
        <div class="confirm-title">Models</div>
        <button type="button" class="icon-btn model-settings-close" title="Close">✕</button>
      </div>
      <p class="hint-text" style="margin: 0 0 14px;">Choose which models show up in each provider's Model Selection dropdown. Disabling a model only hides it here -- it isn't removed from the app, and at least one model must stay enabled per provider.</p>
      <div class="model-settings-body" id="modelSettingsBody"></div>
    </div>`;
  document.body.appendChild(backdrop);

  function close() {
    backdrop.removeEventListener('keydown', onKey);
    backdrop.classList.remove('confirm-in');
    setTimeout(() => backdrop.remove(), 150);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.model-settings-close').addEventListener('click', close);

  renderModelSettingsBody(backdrop.querySelector('#modelSettingsBody'));

  requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('confirm-in')));
}

function renderModelSettingsBody(container) {
  container.innerHTML = providersCache.map(p => `
    <div class="model-settings-provider">
      <div class="model-settings-provider-name">${p.provider}</div>
      <div class="model-settings-list">
        ${p.all_models.map(([label, id]) => {
          const isDisabled = p.disabled_models.includes(id);
          return `
            <label class="model-settings-row">
              <span class="model-settings-label">${label}</span>
              <span class="switch">
                <input type="checkbox" data-provider="${p.provider}" data-model="${id}" ${isDisabled ? '' : 'checked'}>
                <span class="switch-track"></span>
              </span>
            </label>`;
        }).join('')}
      </div>
    </div>`).join('');

  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', async () => {
      const provider = input.dataset.provider;
      const modelId = input.dataset.model;
      const enabled = input.checked;
      input.disabled = true;
      const res = await pywebview.api.set_model_enabled(provider, modelId, enabled);
      input.disabled = false;
      if (!res.ok) {
        input.checked = !enabled; // revert -- e.g. "at least one must stay enabled"
        Toast.show(res.error || 'Could not update model', { type: 'warning' });
        return;
      }
      if (res.new_current_model) {
        Toast.show(`${provider}'s selected model was disabled -- switched to ${res.new_current_model}`, { type: 'info' });
      }
      await loadProviders();
      // Re-render in place so the panel reflects the new state
      // immediately without closing it.
      const p = providersCache.find(x => x.provider === provider);
      if (p) renderModelSettingsBody(container);
    });
  });
}
