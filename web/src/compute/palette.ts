// Semantic coloring for timeline blocks.
//
// Hue is derived from the block's "top frame" (first Python frame in the
// call stack). Every alloc site on the same user-code line gets the
// same hue, so memory from one layer/op forms a visible color band.
//
// Lightness + saturation shift per-instance inside the same top-frame
// group — PyTorch re-executes a single call site hundreds of times
// during training, and without the shift those N allocations would all
// paint identically. Golden-ratio harmonics distribute the shifts so
// adjacent instances never coincide.
//
// Worker-friendly: no DOM / GL imports.

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [r + m, g + m, b + m];
}

const PHI  = 0.61803398875;
const PHI2 = 0.41421356237;

/**
 * Stable color for one timeline block.
 *   hueKey     — groups blocks that share meaning (usually top_frame_idx;
 *                callers fall back to stack_idx / addr when no frame).
 *   instanceIdx — 0-based counter among blocks sharing the same hueKey.
 *                 Drives lightness so repeated allocs from the same line
 *                 fan out as shades in the same family.
 */
export function blockColor(hueKey: number, instanceIdx: number): [number, number, number] {
  const hue = ((hueKey * PHI) % 1) * 360;
  const lig = 0.50 + ((instanceIdx * PHI) % 1) * 0.24;        // 0.50 – 0.74
  const sat = 0.45 + ((instanceIdx * PHI2) % 1) * 0.18;       // 0.45 – 0.63
  return hslToRgb(hue, sat, lig);
}
