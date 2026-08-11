/**
 * core/interaction/movable — transform-based drag + keyboard movement.
 *
 * No DOM mutation — only transform: translate(). Fully reversible (clear
 * transforms). Invisible to framework MutationObservers. Bounded to
 * viewport. Keyboard is a first-class path (Arrow keys + Shift for larger
 * steps). Only elements the design intent marked `movable` (CSS
 * --rv-movable: 1) become movable.
 *
 * The keyboard step is pack-derived: reads `--rv-movable-step` from the
 * element's computed style (set by the compile layer from pack.spacingScale).
 */

let movableCleanup: (() => void) | null = null;

export function startMovableHandlers(): void {
  stopMovableHandlers();
  const els: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-rv-c]'))) {
    if (getComputedStyle(el).getPropertyValue('--rv-movable').trim() === '1') els.push(el);
  }
  if (!els.length) return;

  const transforms = new Map<HTMLElement, { x: number; y: number }>();

  const bound = (el: HTMLElement, dx: number, dy: number): { x: number; y: number } => {
    const t = transforms.get(el) ?? { x: 0, y: 0 };
    const nx = t.x + dx, ny = t.y + dy;
    const r = el.getBoundingClientRect();
    const maxX = window.innerWidth - r.left - r.width / 2;
    const maxY = window.innerHeight - r.top - r.height / 2;
    const minX = -r.left - r.width / 2;
    const minY = -r.top - r.height / 2;
    return { x: Math.max(minX, Math.min(maxX, nx)), y: Math.max(minY, Math.min(maxY, ny)) };
  };

  const apply = (el: HTMLElement): void => {
    const t = transforms.get(el) ?? { x: 0, y: 0 };
    el.style.transform = `translate(${t.x}px, ${t.y}px)`;
  };

  const handlers: { el: HTMLElement; type: string; fn: EventListener }[] = [];

  for (const el of els) {
    // Make focusable for keyboard movement.
    if (!el.hasAttribute('tabindex') && el.tabIndex < 0) el.setAttribute('tabindex', '0');

    // Pointer drag.
    let dragging = false;
    let startX = 0, startY = 0, startTX = 0, startTY = 0;
    const onPointerDown = ((e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const t = transforms.get(el) ?? { x: 0, y: 0 };
      startTX = t.x; startTY = t.y;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
      e.preventDefault();
    }) as EventListener;
    const onPointerMove = ((e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const nx = startTX + dx, ny = startTY + dy;
      const r = el.getBoundingClientRect();
      const maxX = window.innerWidth - r.left - r.width / 2;
      const maxY = window.innerHeight - r.top - r.height / 2;
      const minX = -r.left - r.width / 2;
      const minY = -r.top - r.height / 2;
      transforms.set(el, {
        x: Math.max(minX, Math.min(maxX, nx)),
        y: Math.max(minY, Math.min(maxY, ny)),
      });
      apply(el);
    }) as EventListener;
    const onPointerUp = ((e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = 'grab';
    }) as EventListener;

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    handlers.push({ el, type: 'pointerdown', fn: onPointerDown });
    handlers.push({ el, type: 'pointermove', fn: onPointerMove });
    handlers.push({ el, type: 'pointerup', fn: onPointerUp });

    // Keyboard movement (first-class path).
    const onKeyDown = ((e: KeyboardEvent) => {
      const step = parseFloat(getComputedStyle(el).getPropertyValue('--rv-movable-step')) || 8;
      const big = e.shiftKey ? step * 5 : step;
      let dx = 0, dy = 0;
      switch (e.key) {
        case 'ArrowLeft': dx = -big; break;
        case 'ArrowRight': dx = big; break;
        case 'ArrowUp': dy = -big; break;
        case 'ArrowDown': dy = big; break;
        default: return;
      }
      e.preventDefault();
      const t = bound(el, dx, dy);
      transforms.set(el, t);
      apply(el);
    }) as EventListener;
    el.addEventListener('keydown', onKeyDown);
    handlers.push({ el, type: 'keydown', fn: onKeyDown });
  }

  movableCleanup = () => {
    for (const { el, type, fn } of handlers) el.removeEventListener(type, fn);
    for (const el of els) {
      el.style.transform = '';
      if (el.getAttribute('tabindex') === '0') el.removeAttribute('tabindex');
    }
    transforms.clear();
  };
}

export function stopMovableHandlers(): void {
  if (movableCleanup) { movableCleanup(); movableCleanup = null; }
}