// v0.9.0: click-and-drag ("grab") scrolling for the results areas of
// Meta Generator, Image to Prompt Generator, and Prompt-to-Prompt --
// press and hold the left mouse button anywhere in one of those areas
// and move the mouse up/down to scroll, like panning a map, instead
// of having to land the cursor precisely on the scrollbar.
//
// All three pages share the same single scrolling ancestor
// (<main class="content">) -- .meta-content itself doesn't scroll on
// its own, so dragging inside it (or inside P2P's results panel)
// moves that shared container's scrollTop. Marking the zones with a
// class (rather than hard-coding element ids here) keeps this file
// generic: any future page can opt in just by adding
// "drag-scroll-zone" to its results container in index.html.
//
// Only real controls are excluded -- buttons, links, form fields, and
// anything currently being edited (contenteditable) -- so a click
// still reaches them exactly as before. Everywhere else in the zone
// (card text, labels, empty space, the dropzone, etc.) is drag-to-
// scroll territory, per Hasib's request.
(function () {
  const EXCLUDE_SELECTOR = 'button, a, input, select, textarea, label, [contenteditable="true"]';
  const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag rather than a click

  const scrollHost = document.querySelector('.content');
  if (!scrollHost) return;

  let activeZone = null;
  let dragging = false;
  let startX = 0, startY = 0, startScrollTop = 0;

  function onMouseDown(e) {
    if (e.button !== 0) return; // left button only
    if (e.target.closest(EXCLUDE_SELECTOR)) return; // let the real control handle its own click/drag
    activeZone = e.currentTarget;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    startScrollTop = scrollHost.scrollTop;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (!activeZone) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      dragging = true;
      activeZone.classList.add('dragging');
    }
    e.preventDefault(); // only once actually dragging -- keeps plain clicks/text selection untouched
    scrollHost.scrollTop = startScrollTop - dy;
  }

  function onMouseUp() {
    if (activeZone) activeZone.classList.remove('dragging');
    activeZone = null;
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.querySelectorAll('.drag-scroll-zone').forEach((zone) => {
    zone.addEventListener('mousedown', onMouseDown);
  });
})();
