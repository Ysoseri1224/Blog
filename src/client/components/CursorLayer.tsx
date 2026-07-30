import { useEffect, useRef } from 'react';

type CursorKind = 'default' | 'link' | 'text' | 'drag' | 'resize' | 'disabled' | 'wait';

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

export function CursorLayer() {
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
    let visible = false;

    const animate = () => {
      easedX += (x - easedX) * .28;
      easedY += (y - easedY) * .28;
      ringRef.current?.style.setProperty('transform', `translate3d(${easedX}px,${easedY}px,0)`);
      if (Math.abs(x - easedX) > .08 || Math.abs(y - easedY) > .08) frame = requestAnimationFrame(animate);
      else frame = 0;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(animate); };
    const setVisible = (next: boolean) => {
      visible = next;
      ringRef.current?.setAttribute('data-visible', String(next));
      dotRef.current?.setAttribute('data-visible', String(next));
    };
    const move = (event: PointerEvent) => {
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
      ringRef.current?.setAttribute('data-cursor', cursorKind(target));
      schedule();
    };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) setVisible(false); };
    const press = () => ringRef.current?.setAttribute('data-pressed', 'true');
    const release = () => ringRef.current?.removeAttribute('data-pressed');
    const hide = () => setVisible(false);

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerout', leave, { passive: true });
    addEventListener('pointerdown', press, { passive: true });
    addEventListener('pointerup', release, { passive: true });
    addEventListener('pointercancel', release, { passive: true });
    addEventListener('blur', hide);
    root.dataset.customCursor = 'ready';

    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerout', leave);
      removeEventListener('pointerdown', press);
      removeEventListener('pointerup', release);
      removeEventListener('pointercancel', release);
      removeEventListener('blur', hide);
      if (frame) cancelAnimationFrame(frame);
      root.removeAttribute('data-custom-cursor');
      root.style.removeProperty('--pointer-x');
      root.style.removeProperty('--pointer-y');
    };
  }, []);

  return <>
    <div className="cursor-ring" ref={ringRef}/>
    <div className="cursor-dot" ref={dotRef}/>
    <div className="cursor-spotlight"/>
  </>;
}
