// v0.8.7: previously a single hardcoded dark-only preset list -- picking
// White mode still showed the 3 dark swatches (Jet Black/Charcoal/Gray),
// which did nothing useful once the palette was already light, and
// applyBgOverride() silently no-op'd in light mode for the same reason.
// Now genuinely mode-aware: each mode gets its own 3 presets, and the
// swatch row rebuilds whenever the mode changes.
const BG_PRESETS_DARK = ['#000000', '#1c1c1c', '#4a4a4a'];   // Vantablack, Dark Charcoal, Dark Gray
const BG_PRESETS_LIGHT = ['#ffffff', '#f5f3ee', '#e7e9ec'];  // Pure White, Warm Ivory, Cool Light Gray
const BG_PRESETS_NEON = ['#0a0e17', '#0d1220', '#111a2e'];   // Deep Navy, Midnight Blue, Indigo Night
const ACCENT_PRESETS = ['#4caf7d', '#e5686b', '#a259e6', '#e6599e', '#8b6fe6', '#e6a24c', '#5b8cff', '#00bfa5'];

const bgSwatches = document.getElementById('bgSwatches');
const accentSwatches = document.getElementById('accentSwatches');
const bgHexInput = document.getElementById('bgHexInput');
const accentHexInput = document.getElementById('accentHexInput');
const themeModeRow = document.getElementById('themeModeRow');

function buildSwatches(container, colors, input, cssVar) {
  container.innerHTML = '';
  colors.forEach(hex => {
    const dot = document.createElement('button');
    dot.className = 'swatch';
    dot.style.background = hex;
    dot.title = hex;
    dot.addEventListener('click', () => {
      input.value = hex;
      if (cssVar === '--bg1') {
        ThemeManager.applyBgOverride(hex);
      } else {
        document.documentElement.style.setProperty(cssVar, hex);
      }
    });
    container.appendChild(dot);
  });
}

function buildBgSwatchesForMode(mode) {
  const presets = mode === 'light' ? BG_PRESETS_LIGHT : mode === 'neon' ? BG_PRESETS_NEON : BG_PRESETS_DARK;
  buildSwatches(bgSwatches, presets, bgHexInput, '--bg1');
}

buildBgSwatchesForMode(ThemeManager.getMode());
buildSwatches(accentSwatches, ACCENT_PRESETS, accentHexInput, '--accent');

bgHexInput.value = getComputedStyle(document.documentElement).getPropertyValue('--bg1').trim();
accentHexInput.value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

bgHexInput.addEventListener('change', () => {
  ThemeManager.applyBgOverride(bgHexInput.value);
});
accentHexInput.addEventListener('change', () => {
  ThemeManager.applyAccent(accentHexInput.value);
});

function setThemeModeButtons(mode) {
  themeModeRow.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

themeModeRow.querySelectorAll('.theme-mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    ThemeManager.applyPalette(mode);
    buildBgSwatchesForMode(mode);
    // Restore this mode's own saved bg override (if any) rather than
    // carrying over whatever hex was showing for the previous mode --
    // otherwise a dark override picked in Dark mode would get applied
    // as White mode's background the moment you switch to it.
    const res = await pywebview.api.get_prefs();
    const prefs = (res && res.ok && res.prefs) || {};
    const saved = prefs[ThemeManager.bgPrefKey(mode)];
    bgHexInput.value = saved || getComputedStyle(document.documentElement).getPropertyValue('--bg1').trim();
    if (saved) ThemeManager.applyBgOverride(saved);
    setThemeModeButtons(mode);
    await pywebview.api.save_prefs({ theme_mode: mode });
  });
});

document.getElementById('btnApplyTheme').addEventListener('click', async () => {
  // Applies live (already done via the input listeners above) and
  // persists via the real prefs store, unlike the original which
  // required a full app restart to take effect -- a genuine
  // improvement the web-based UI allows for free. Saved under a
  // per-mode key so Dark and White each remember their own background
  // override independently.
  await pywebview.api.save_prefs({
    [ThemeManager.bgPrefKey(ThemeManager.getMode())]: bgHexInput.value,
    theme_accent_base: accentHexInput.value,
  });
});

onPywebviewReady(async () => {
  const res = await pywebview.api.get_prefs();
  if (res.ok) {
    const prefs = res.prefs || {};
    const mode = ['light', 'neon'].includes(prefs.theme_mode) ? prefs.theme_mode : 'dark';
    setThemeModeButtons(mode);
    buildBgSwatchesForMode(mode);
    const savedBg = prefs[ThemeManager.bgPrefKey(mode)] || (mode === 'dark' ? prefs.theme_bg_base : null);
    if (savedBg) bgHexInput.value = savedBg;
    if (prefs.theme_accent_base) accentHexInput.value = prefs.theme_accent_base;
  } else {
    setThemeModeButtons('dark');
  }
});
