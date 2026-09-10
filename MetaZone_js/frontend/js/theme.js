// theme.js — shared, app-wide theme system.
//
// Previously only --bg1 and --accent were ever touched (appearance.js),
// which meant there was no real "White theme" possible (text/borders/
// panels stayed hardcoded dark), and whatever was picked was never
// re-applied on the next launch (save_prefs wrote theme_bg_base /
// theme_accent_base, but nothing ever read them back at startup — the
// page just always booted into the default dark :root values).
//
// This file defines a full palette per mode (dark/light), applies it to
// :root as real CSS custom properties (every panel/card/scrollbar in
// base.css already keys off these vars, so nothing else needs to change
// to "become" a white theme), and reloads + re-applies the saved choice
// on every page load — including popup windows (API Manager / Embed),
// so they always match whatever the main window is currently showing.

const THEME_PALETTES = {
  dark: {
    '--bg1': '#1a1c22',
    '--bg2': '#22252c',
    '--nav-bg': '#16181d',
    '--text': '#e7e9ee',
    '--text-dim': '#9aa0ac',
    '--border': '#2e323b',
  },
  light: {
    '--bg1': '#ffffff',
    '--bg2': '#f4f5f7',
    '--nav-bg': '#f7f7f9',
    '--text': '#1b1d22',
    '--text-dim': '#6a6f7b',
    '--border': '#dfe1e6',
  },
  // v0.9.4: third theme option -- deep navy base with a cyan/teal
  // neon accent, gradient buttons, and glowing borders (see the
  // [data-theme="neon"] overrides in base.css for the gradient/glow
  // treatment itself; the vars here are just this mode's base
  // palette, same mechanism as dark/light above). Default accent is
  // baked in here since "neon" isn't really neon without a cyan glow,
  // but it's still just a normal --accent value underneath -- the
  // existing accent swatches/hex input override it exactly like they
  // override dark/light's accent today.
  neon: {
    '--bg1': '#0a0e17',
    '--bg2': '#0f1524',
    '--nav-bg': '#080b12',
    '--text': '#e8f4ff',
    '--text-dim': '#7c92b3',
    '--border': '#1c2b45',
    '--accent': '#00e5ff',
  },
};

const ThemeManager = (() => {
  let currentMode = 'dark';

  function applyPalette(mode) {
    const palette = THEME_PALETTES[mode] || THEME_PALETTES.dark;
    const root = document.documentElement.style;
    Object.entries(palette).forEach(([k, v]) => root.setProperty(k, v));
    currentMode = mode;
    document.documentElement.dataset.theme = mode;
  }

  function applyAccent(hex) {
    if (hex) document.documentElement.style.setProperty('--accent', hex);
  }

  function applyBgOverride(hex) {
    // v0.8.7: previously hardcoded to dark mode only -- but White mode
    // needs its own fine-tune swatches too (Pure White / Warm Ivory /
    // Cool Light Gray), so this now applies in either mode. --bg1 is
    // still just the base background var either way; the rest of the
    // palette (text/border/nav) stays whatever applyPalette(mode) set.
    if (hex) {
      document.documentElement.style.setProperty('--bg1', hex);
    }
  }

  function bgPrefKey(mode) {
    // Per-mode storage: a dark override (e.g. #1c1c1c) must never get
    // applied as another mode's background, and vice versa --
    // theme_bg_base was a single shared key pre-v0.8.7, which is
    // exactly that bug waiting to happen the first time someone picked
    // a dark swatch, then switched modes.
    if (mode === 'light') return 'theme_bg_base_light';
    if (mode === 'neon') return 'theme_bg_base_neon';
    return 'theme_bg_base_dark';
  }

  async function loadAndApply() {
    try {
      const res = await pywebview.api.get_prefs();
      if (!res.ok) return;
      const prefs = res.prefs || {};
      const mode = THEME_PALETTES[prefs.theme_mode] ? prefs.theme_mode : 'dark';
      applyPalette(mode);
      // Falls back to the legacy shared key (pre-v0.8.7 saves), which
      // was dark-only in practice, so it's only used as a dark-mode
      // fallback -- never applied to light/neon mode.
      const bg = prefs[bgPrefKey(mode)] || (mode === 'dark' ? prefs.theme_bg_base : null);
      if (bg) applyBgOverride(bg);
      if (prefs.theme_accent_base) applyAccent(prefs.theme_accent_base);
    } catch (e) {
      applyPalette('dark');
    }
  }

  return { applyPalette, applyAccent, applyBgOverride, loadAndApply, getMode: () => currentMode, bgPrefKey };
})();

onPywebviewReady(() => ThemeManager.loadAndApply());
