import { useEffect, useRef } from 'react';

type CursorKind = 'default' | 'link' | 'text' | 'drag' | 'resize' | 'disabled' | 'wait';

const PROXIMITY_HIGHLIGHT = 'blog-cursor-proximity';
const PROXIMITY_RADIUS = 40;
const PROXIMITY_SAMPLE_STEP = 10;
const PROXIMITY_EXCLUDED = 'script,style,noscript,input,textarea,select,option,[contenteditable="true"],.cm-editor,.cm-content,[aria-hidden="true"],[data-cursor-proximity="off"]';

function cursorKind(target: Element | null): CursorKind {
  const explicit = target?.closest<HTMLElement>('[data-cursor]')?.dataset.cursor;
  if (explicit === 'link' || explicit === 'text' || explicit === 'drag' || explicit === 'resize' || explicit === 'disabled' || explicit === 'wait') return explicit;
  if (target?.closest(':disabled,[aria-disabled="true"]')) return 'disabled';
  if (target?.closest('[aria-busy="true"]')) return 'wait';
  if (target?.closest('[draggable="true"]')) return 'drag';
  if (target?.closest('textarea,[contenteditable="true"],.cm-content,.markdown-body,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])')) return 'text';
  if (target?.closest('a,button,select,summary,[role="button"],[role="tab"]')) return 'link';
  return 'default';
}

type TextPosition = { node: Text; offset: number };

function eligibleTextPosition(node: Node | null, offset: number): TextPosition | null {
  if (!(node instanceof Text)) return null;
  const parent = node.parentElement;
  if (!parent || !node.data.trim() || parent.closest(PROXIMITY_EXCLUDED)) return null;
  return { node, offset: Math.max(0, Math.min(offset, node.length)) };
}

function textPositionAtPoint(documentNode: Document, x: number, y: number): TextPosition | null {
  if (typeof documentNode.caretPositionFromPoint === 'function') {
    const position = documentNode.caretPositionFromPoint(x, y);
    const resolved = eligibleTextPosition(position?.offsetNode ?? null, position?.offset ?? 0);
    if (resolved) return resolved;
  }
  if (typeof documentNode.caretRangeFromPoint === 'function') {
    const range = documentNode.caretRangeFromPoint(x, y);
    return eligibleTextPosition(range?.startContainer ?? null, range?.startOffset ?? 0);
  }
  return null;
}

function distanceToRectSquared(x: number, y: number, rect: DOMRect): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

function proximityRanges(documentNode: Document, x: number, y: number): Range[] {
  const radiusSquared = PROXIMITY_RADIUS * PROXIMITY_RADIUS;
  const indexesByNode = new Map<Text, Set<number>>();
  const measured = new Map<Text, Map<number, boolean>>();
  const viewportWidth = documentNode.documentElement.clientWidth;
  const viewportHeight = documentNode.documentElement.clientHeight;

  const includeCharacter = (node: Text, index: number) => {
    if (index < 0 || index >= node.length) return;
    let nodeMeasurements = measured.get(node);
    if (!nodeMeasurements) {
      nodeMeasurements = new Map();
      measured.set(node, nodeMeasurements);
    }
    let withinRadius = nodeMeasurements.get(index);
    if (withinRadius === undefined) {
      const range = documentNode.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      withinRadius = Array.from(range.getClientRects()).some((rect) => distanceToRectSquared(x, y, rect) <= radiusSquared);
      nodeMeasurements.set(index, withinRadius);
    }
    if (!withinRadius) return;
    let indexes = indexesByNode.get(node);
    if (!indexes) {
      indexes = new Set();
      indexesByNode.set(node, indexes);
    }
    indexes.add(index);
  };

  for (let dy = -PROXIMITY_RADIUS; dy <= PROXIMITY_RADIUS; dy += PROXIMITY_SAMPLE_STEP) {
    const sampleY = y + dy;
    if (sampleY < 0 || sampleY >= viewportHeight) continue;
    const halfChord = Math.sqrt(radiusSquared - dy * dy);
    for (let dx = -halfChord; dx <= halfChord; dx += PROXIMITY_SAMPLE_STEP) {
      const sampleX = x + dx;
      if (sampleX < 0 || sampleX >= viewportWidth) continue;
      const position = textPositionAtPoint(documentNode, sampleX, sampleY);
      if (!position) continue;
      includeCharacter(position.node, position.offset - 1);
      includeCharacter(position.node, position.offset);
    }
  }

  const ranges: Range[] = [];
  indexesByNode.forEach((indexes, node) => {
    const sorted = Array.from(indexes).sort((left, right) => left - right);
    let start = sorted[0];
    let end = start;
    const pushRange = () => {
      const range = documentNode.createRange();
      range.setStart(node, start);
      range.setEnd(node, end + 1);
      ranges.push(range);
    };
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] === end + 1) {
        end = sorted[index];
      } else {
        pushRange();
        start = sorted[index];
        end = start;
      }
    }
    pushRange();
  });
  return ranges;
}

export function CursorLayer() {
  const trackerRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const finePointer = matchMedia('(pointer: fine)');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    if (!finePointer.matches || reducedMotion.matches) {
      root.removeAttribute('data-custom-cursor');
      return;
    }

    let x = -100;
    let y = -100;
    let easedX = x;
    let easedY = y;
    let frame = 0;
    let proximityFrame = 0;
    let lastProximityFrame = -Infinity;
    let proximityEnabled = true;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? CSS.highlights : null;

    const clearProximity = () => highlights?.delete(PROXIMITY_HIGHLIGHT);
    const updateProximity = (time: number) => {
      if (time - lastProximityFrame < 32) {
        proximityFrame = requestAnimationFrame(updateProximity);
        return;
      }
      proximityFrame = 0;
      lastProximityFrame = time;
      if (!highlights || !visible || !proximityEnabled) {
        clearProximity();
        return;
      }
      const ranges = proximityRanges(document, x, y);
      if (ranges.length) highlights.set(PROXIMITY_HIGHLIGHT, new Highlight(...ranges));
      else clearProximity();
    };
    const scheduleProximity = () => {
      if (highlights && !proximityFrame) proximityFrame = requestAnimationFrame(updateProximity);
    };

    const animate = () => {
      easedX += (x - easedX) * .28;
      easedY += (y - easedY) * .28;
      trackerRef.current?.style.setProperty('transform', `translate3d(${easedX}px,${easedY}px,0)`);
      if (Math.abs(x - easedX) > .08 || Math.abs(y - easedY) > .08) frame = requestAnimationFrame(animate);
      else frame = 0;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(animate); };
    const setVisible = (next: boolean) => {
      visible = next;
      trackerRef.current?.setAttribute('data-visible', String(next));
      dotRef.current?.setAttribute('data-visible', String(next));
    };
    const move = (event: PointerEvent) => {
      if (event.buttons === 0) ringRef.current?.removeAttribute('data-pressed');
      x = event.clientX;
      y = event.clientY;
      if (!visible) {
        easedX = x;
        easedY = y;
        setVisible(true);
      }
      dotRef.current?.style.setProperty('transform', `translate3d(${x}px,${y}px,0)`);
      root.style.setProperty('--pointer-x', `${x}px`);
      root.style.setProperty('--pointer-y', `${y}px`);
      const target = event.target instanceof Element ? event.target : null;
      const kind = cursorKind(target);
      ringRef.current?.setAttribute('data-cursor', kind);
      dotRef.current?.setAttribute('data-cursor', kind);
      proximityEnabled = !target?.closest(PROXIMITY_EXCLUDED);
      schedule();
      scheduleProximity();
    };
    const leave = (event: PointerEvent) => {
      if (!event.relatedTarget) {
        ringRef.current?.removeAttribute('data-pressed');
        setVisible(false);
        clearProximity();
      }
    };
    const press = () => ringRef.current?.setAttribute('data-pressed', 'true');
    const release = () => ringRef.current?.removeAttribute('data-pressed');
    const hide = () => {
      release();
      setVisible(false);
      clearProximity();
    };
    const visibility = () => { if (document.hidden) hide(); };
    const scroll = () => {
      clearProximity();
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(scheduleProximity, 64);
    };

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerout', leave, { passive: true });
    addEventListener('pointerdown', press, { passive: true });
    addEventListener('pointerup', release, { passive: true });
    addEventListener('pointercancel', release, { passive: true });
    addEventListener('dragend', release, { passive: true });
    addEventListener('contextmenu', release, { passive: true });
    addEventListener('blur', hide);
    addEventListener('scroll', scroll, { passive: true, capture: true });
    document.addEventListener('visibilitychange', visibility);
    root.dataset.customCursor = 'ready';

    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerout', leave);
      removeEventListener('pointerdown', press);
      removeEventListener('pointerup', release);
      removeEventListener('pointercancel', release);
      removeEventListener('dragend', release);
      removeEventListener('contextmenu', release);
      removeEventListener('blur', hide);
      removeEventListener('scroll', scroll, true);
      document.removeEventListener('visibilitychange', visibility);
      if (frame) cancelAnimationFrame(frame);
      if (proximityFrame) cancelAnimationFrame(proximityFrame);
      if (scrollTimer) clearTimeout(scrollTimer);
      clearProximity();
      root.removeAttribute('data-custom-cursor');
      root.style.removeProperty('--pointer-x');
      root.style.removeProperty('--pointer-y');
    };
  }, []);

  return <>
    <div className="cursor-tracker" ref={trackerRef}><div className="cursor-ring" ref={ringRef}/></div>
    <div className="cursor-dot" ref={dotRef}/>
    <div className="cursor-spotlight"/>
  </>;
}
