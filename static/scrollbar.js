// Native scrollbar thumbs are proportional to content; CSS cannot fix their
// height. Keep native scrolling and overlay a 12px thumb on each scroll area.
export function enhanceScrollbars(root = document) {
  const selector = '#input, #settings-scroll, #history-dialog, .history-item p, .select-menu';
  const instances = new Map();
  let frame = 0, sequence = 0;
  const resize = new ResizeObserver(schedule);
  function schedule() {
    if (!frame) frame = requestAnimationFrame(refresh);
  }
  function attach(scroller) {
    const external = scroller instanceof HTMLTextAreaElement;
    const host = external ? scroller.parentElement : scroller;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    scroller.classList.add('custom-scrollbar-native');
    scroller.id ||= `scroll-content-${++sequence}`;
    const track = document.createElement('div'); track.className = 'vertical-scrollbar';
    const thumb = document.createElement('div'); thumb.className = 'vertical-scrollbar-thumb';
    thumb.tabIndex = 0; thumb.setAttribute('role', 'scrollbar');
    thumb.setAttribute('aria-label', '垂直滚动条');
    thumb.setAttribute('aria-orientation', 'vertical');
    thumb.setAttribute('aria-controls', scroller.id);
    thumb.setAttribute('aria-valuemin', '0');
    track.append(thumb); host.append(track);
    let trackHeight = 0, dragging = false, grab = 6;
    function update() {
      const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      trackHeight = Math.max(0, scroller.clientHeight - 4);
      track.hidden = maximum <= 1 || trackHeight < 12;
      if (track.hidden) return;
      // An internal overlay follows scrollTop so it stays at the viewport edge,
      // without adding to scrollHeight. Textareas use an external sibling.
      const top = external ? scroller.offsetTop + scroller.clientTop : scroller.scrollTop;
      const left = external ? scroller.offsetLeft + scroller.clientLeft : scroller.scrollLeft;
      track.style.top = `${top + 2}px`;
      track.style.left = `${left + scroller.clientWidth - 8}px`;
      track.style.height = `${trackHeight}px`;
      const travel = trackHeight - 12;
      thumb.style.transform = `translateY(${travel * Math.min(1, scroller.scrollTop / maximum)}px)`;
      thumb.setAttribute('aria-valuemax', String(maximum));
      thumb.setAttribute('aria-valuenow', String(Math.round(scroller.scrollTop)));
    }
    function move(event) {
      const bounds = track.getBoundingClientRect();
      if (!bounds.height || trackHeight <= 12) return;
      // Convert pointer coordinates back to CSS pixels for the scaled printer.
      const y = (event.clientY - bounds.top) * trackHeight / bounds.height;
      const ratio = Math.max(0, Math.min(1, (y - grab) / (trackHeight - 12)));
      scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
      update();
    }
    track.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); update();
      const bounds = track.getBoundingClientRect();
      grab = event.target === thumb ? (event.clientY - thumb.getBoundingClientRect().top) * trackHeight / bounds.height : 6;
      dragging = true; track.setPointerCapture(event.pointerId);
      thumb.focus({ preventScroll: true }); move(event);
    });
    track.addEventListener('pointermove', event => { if (dragging) move(event); });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      track.addEventListener(name, () => { dragging = false; });
    }
    thumb.addEventListener('keydown', event => {
      const maximum = scroller.scrollHeight - scroller.clientHeight;
      const targets = {
        ArrowUp: scroller.scrollTop - 40, ArrowDown: scroller.scrollTop + 40,
        PageUp: scroller.scrollTop - scroller.clientHeight,
        PageDown: scroller.scrollTop + scroller.clientHeight,
        Home: 0, End: maximum,
      };
      if (event.key in targets) {
        event.preventDefault(); event.stopPropagation();
        scroller.scrollTop = targets[event.key]; update();
      }
    });
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('input', schedule);
    resize.observe(scroller);
    instances.set(scroller, { track, update });
  }
  function refresh() {
    frame = 0;
    for (const scroller of root.querySelectorAll(selector)) {
      if (!instances.has(scroller)) attach(scroller);
    }
    for (const [scroller, instance] of instances) {
      if (!scroller.isConnected) {
        resize.unobserve(scroller); instance.track.remove(); instances.delete(scroller);
      } else instance.update();
    }
  }
  // History rows and listboxes can be created after the initial page load.
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true, characterData: true });
  addEventListener('resize', schedule);
  document.fonts.ready.then(schedule);
  schedule();
}
