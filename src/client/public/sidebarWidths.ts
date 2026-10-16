export type SidebarSide = 'left' | 'right';
export interface SidebarWidths { left: number; right: number; }

export const defaultSidebarWidths: SidebarWidths = { left: 292, right: 280 };
const minWidth: Record<SidebarSide, number> = { left: 220, right: 200 };
const maxWidth: Record<SidebarSide, number> = { left: 560, right: 520 };
const maxViewportShare = 0.4;
const storageKey = 'blog-sidebar-widths';

export function clampSidebarWidth(side: SidebarSide, width: number, viewportWidth: number): number {
  const upper = Math.max(minWidth[side], Math.min(maxWidth[side], Math.floor(viewportWidth * maxViewportShare)));
  if (!Number.isFinite(width)) return defaultSidebarWidths[side];
  return Math.round(Math.min(upper, Math.max(minWidth[side], width)));
}

export function readSidebarWidths(): SidebarWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<SidebarWidths>;
    return {
      left: typeof parsed.left === 'number' ? parsed.left : defaultSidebarWidths.left,
      right: typeof parsed.right === 'number' ? parsed.right : defaultSidebarWidths.right,
    };
  } catch { return defaultSidebarWidths; }
}

export function writeSidebarWidths(widths: SidebarWidths): void {
  try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch { /* 隐私模式下仍可调节，只是不记住。 */ }
}
