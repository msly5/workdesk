const STORAGE_KEY = 'workdesk.inspectorWidth';
const DEFAULT_WIDTH = 420;

export function inspectorBounds(viewportWidth, sidebarWidth = 0) {
  const max = viewportWidth <= 600 ? viewportWidth
    : Math.max(280, viewportWidth - sidebarWidth - (viewportWidth >= 1100 ? 360 : 24));
  return { min: Math.min(320, max), max };
}

export function clampInspectorWidth(width, bounds) {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, Number.isFinite(width) ? width : DEFAULT_WIDTH)));
}

export function initInspectorResize() {
  const handle = document.querySelector('#inspector-resize');
  const root = document.documentElement;
  let preferred = DEFAULT_WIDTH, drag = null;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (stored > 0) preferred = stored;
  } catch { /* The panel still works when browser storage is unavailable. */ }
  const bounds = () => inspectorBounds(innerWidth, parseFloat(getComputedStyle(root).getPropertyValue('--sidebar')) || 0);
  const apply = () => {
    const limits = bounds();
    const width = innerWidth <= 600 ? limits.max : clampInspectorWidth(preferred, limits);
    root.style.setProperty('--inspector-width', width + 'px');
    handle.setAttribute('aria-valuemin', limits.min);
    handle.setAttribute('aria-valuemax', limits.max);
    handle.setAttribute('aria-valuenow', width);
    return width;
  };
  const remember = () => { try { localStorage.setItem(STORAGE_KEY, String(preferred)); } catch {} };
  const finish = event => {
    if (!drag || event && event.pointerId !== undefined && event.pointerId !== drag.id) return;
    const { id } = drag; drag = null;
    document.body.classList.remove('resizing-inspector');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    remember();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, width: apply() };
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    document.body.classList.add('resizing-inspector');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    preferred = clampInspectorWidth(drag.width + drag.x - event.clientX, bounds());
    apply();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
  window.addEventListener('blur', () => finish());
  window.addEventListener('resize', apply);
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const limits = bounds(), step = event.shiftKey ? 48 : 16;
    preferred = event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max
      : clampInspectorWidth(apply() + (event.key === 'ArrowLeft' ? step : -step), limits);
    apply(); remember();
  });
  handle.addEventListener('dblclick', () => { preferred = DEFAULT_WIDTH; apply(); remember(); });
  apply();
}
