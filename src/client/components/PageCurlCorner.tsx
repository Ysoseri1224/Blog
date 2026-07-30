import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export function PageCurlCorner() {
  const [ready, setReady] = useState(false);
  const touchReadyRef = useRef(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const disarm = () => {
    touchReadyRef.current = false;
    setReady(false);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  };
  const armTouch = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || touchReadyRef.current) return;
    event.preventDefault();
    touchReadyRef.current = true;
    setReady(true);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(disarm, 2000);
  };

  return <div
    className={`page-corner-zone ${ready ? 'touch-ready' : ''}`}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') setReady(true); }}
    onPointerLeave={(event) => { if (event.pointerType !== 'touch') setReady(false); }}
    onPointerDown={armTouch}
  >
    <a
      className="page-curl-link"
      href="/manage"
      aria-label="进入管理"
      onFocus={() => setReady(true)}
      onBlur={() => { if (!touchReadyRef.current) setReady(false); }}
      onClick={() => disarm()}
      onKeyDown={(event) => {
        if (event.key === ' ') {
          event.preventDefault();
          window.location.assign('/manage');
        }
      }}
    ><span className="sr-only">进入管理</span></a>
    <svg className="page-curl-visual" viewBox="0 0 72 72" aria-hidden="true">
      <defs>
        <linearGradient id="curl-underlay" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--surface-2)"/>
          <stop offset=".58" stopColor="var(--surface)"/>
          <stop offset="1" stopColor="var(--bg)"/>
        </linearGradient>
        <linearGradient id="curl-paper-back" x1=".92" y1=".14" x2=".18" y2=".9">
          <stop offset="0" stopColor="var(--document-bg)"/>
          <stop offset=".45" stopColor="var(--surface-raised)"/>
          <stop offset=".82" stopColor="var(--surface-2)"/>
          <stop offset="1" stopColor="var(--surface)"/>
        </linearGradient>
        <linearGradient id="curl-back-light" x1=".9" y1=".1" x2=".2" y2=".85">
          <stop offset="0" stopColor="var(--document-bg)" stopOpacity=".82"/>
          <stop offset=".62" stopColor="var(--document-bg)" stopOpacity=".08"/>
          <stop offset="1" stopColor="var(--text)" stopOpacity=".08"/>
        </linearGradient>
        <filter id="curl-soft-shadow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.6"/>
        </filter>
        <filter id="curl-contact-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.15"/>
        </filter>
      </defs>
      <g className="page-curl-reveal">
        <path className="page-curl-underlay" d="M72 18L72 72L18 72C31 64 42 57 51 48C60 39 67 28 72 18Z" fill="url(#curl-underlay)"/>
        <path className="page-curl-contact" d="M18 72C31 64 42 57 51 48C60 39 67 28 72 18"/>
      </g>
      <g className="page-curl-fold">
        <path className="page-curl-cast" d="M72 18C62 19 50 36 34 38C34 53 22 65 18 72C31 64 42 57 51 48C60 39 67 28 72 18Z"/>
        <path className="page-curl-back" d="M72 18C62 19 50 36 34 38C34 53 22 65 18 72C31 64 42 57 51 48C60 39 67 28 72 18Z" fill="url(#curl-paper-back)"/>
        <path className="page-curl-reflection" d="M68 21C58 23 48 34 37 39C37 49 29 59 22 66C33 59 42 52 49 44C57 36 64 27 68 21Z" fill="url(#curl-back-light)"/>
        <path className="page-curl-free-edge" d="M72 18C62 19 50 36 34 38C34 53 22 65 18 72"/>
        <path className="page-curl-crease" d="M18 72C31 64 42 57 51 48C60 39 67 28 72 18"/>
      </g>
    </svg>
  </div>;
}
