// Shared color + font tokens for the canvas-based views (PhaseTimeline,
// SegmentTimeline, etc.). React / CSS surfaces should use the matching
// CSS custom properties defined in index.css instead — these are for
// places we have to hand raw strings to the 2D canvas API.

export const COLOR_BG = "#0a0a0b";
export const COLOR_DIVIDER = "#17171a";
export const COLOR_GRID = "#17171a";
export const COLOR_AXIS = "#52525b";
export const COLOR_AXIS_DIM = "#3f3f46";
export const COLOR_LABEL = "#a1a1aa";
export const COLOR_LABEL_DIM = "#52525b";
export const COLOR_ACCENT = "#d9f99d";
export const COLOR_PEAK = "#f87171";
/** Private-pool accent used by the SegmentTimeline left gutter. */
export const COLOR_PRIVATE = "#fbbf24";

export const FONT_MONO = '11px "JetBrains Mono", ui-monospace, monospace';
export const FONT_MONO_SM = '10px "JetBrains Mono", ui-monospace, monospace';
export const FONT_DISPLAY_SM = '10px "Space Grotesk", sans-serif';
