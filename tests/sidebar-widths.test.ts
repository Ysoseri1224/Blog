import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, defaultSidebarWidths } from '../src/client/public/sidebarWidths';

describe('sidebar width clamping', () => {
  it('keeps widths inside the per-side minimum and maximum', () => {
    expect(clampSidebarWidth('left', 100, 1920)).toBe(220);
    expect(clampSidebarWidth('right', 100, 1920)).toBe(200);
    expect(clampSidebarWidth('left', 900, 1920)).toBe(560);
    expect(clampSidebarWidth('right', 900, 1920)).toBe(520);
  });

  it('never lets one sidebar take more than 40% of the viewport', () => {
    expect(clampSidebarWidth('left', 520, 1000)).toBe(400);
    expect(clampSidebarWidth('right', 520, 1000)).toBe(400);
  });

  it('keeps the minimum on narrow viewports and rounds to whole pixels', () => {
    expect(clampSidebarWidth('left', 300, 400)).toBe(220);
    expect(clampSidebarWidth('right', 250.6, 1440)).toBe(251);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampSidebarWidth('left', Number.NaN, 1440)).toBe(defaultSidebarWidths.left);
  });
});
