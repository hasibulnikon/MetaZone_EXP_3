// Real page switching -- previously the nav buttons only toggled the
// `active` class with no page ever actually hiding/showing.
// v0.8.8: crossfades instead of a hard cut -- the outgoing page fades
// out and only becomes `hidden` once that animation actually finishes
// (via Animate.pageFadeOut's animationend hook, not a timer), while
// the incoming page fades in immediately in parallel. Nothing about
// *when* the switch functionally happens changes: `sec.hidden` for
// the target page is still set synchronously, same as before -- only
// the previously-visible page's hide is deferred by one short
// animation, purely a visual polish with no functional delay.
// v0.8.9: switched to a pure opacity fade (Animate.pageFadeIn /
// pageFadeOut) instead of the translateY-based fade-target /
// fade-out-target classes -- those moved the page vertically while
// fading, which looked like the old page sliding down as the new one
// appeared. Full-page transitions now just fade in place.
// v0.8.9.2: that switch only changed which classes nav.js *adds* --
// every <section class="page ..."> in index.html still had the old
// "fade-target" class baked in statically. Because that class matches
// unconditionally, the browser replayed its own translateY(6px)->0
// keyframe on top of page-fade-in every single time a page went from
// hidden to visible, so the two animations ran at once with different
// durations/easings -- the visible symptom being the incoming page's
// header briefly appearing offset (low in the window) before snapping
// into place. Removed "fade-target" from every page section in
// index.html; pageFadeIn/pageFadeOut are now the only animation
// touching full-page transitions.
function goToPage(target) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === target));

  const pages = document.querySelectorAll('.page');
  pages.forEach(sec => {
    const match = sec.id === `page-${target}`;
    if (match) {
      sec.hidden = false;
      Animate.pageFadeIn(sec);
    } else if (!sec.hidden) {
      Animate.pageFadeOut(sec, () => { sec.hidden = true; });
    } else {
      sec.hidden = true;
    }
  });
}

// Popup mode: a real secondary pywebview window (see
// Api.open_api_manager_popup) loads this same index.html with
// ?popup=api -- strip the app chrome (topbar/sidebar/statusbar) and
// show only the requested page, full-size, in the small window.
const popupParam = new URLSearchParams(location.search).get('popup');
if (popupParam) {
  document.body.classList.add('popup-mode');
  document.addEventListener('DOMContentLoaded', () => goToPage(popupParam));
  // DOMContentLoaded may have already fired by the time this script
  // (loaded at the end of <body>) runs -- cover both orders.
  if (document.readyState !== 'loading') goToPage(popupParam);
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => goToPage(btn.dataset.page));
});

// Dashboard's quick-launch buttons reuse the same [data-page] pattern.
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => goToPage(btn.dataset.page));
});
