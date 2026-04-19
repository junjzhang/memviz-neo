// Muted palette — 12 evenly-spaced hues at low saturation (~35%).
// Balanced cool/warm, avoids yellow-brown dominance. Kept in a WebGL-free
// module so workers can import it without pulling in DOM/GL code.
export const STRIP_PALETTE_RGB: readonly (readonly [number, number, number])[] = [
  [0.42, 0.56, 0.73],  // steel blue    #6b8fba
  [0.49, 0.49, 0.73],  // indigo        #7d7cba
  [0.58, 0.49, 0.73],  // violet        #947cba
  [0.69, 0.49, 0.71],  // orchid        #b07cb5
  [0.69, 0.49, 0.58],  // mauve rose    #b07c93
  [0.69, 0.54, 0.49],  // terracotta    #b08a7c
  [0.69, 0.62, 0.49],  // sand          #b09f7c
  [0.54, 0.69, 0.49],  // sage          #8ab07c
  [0.49, 0.69, 0.54],  // mint          #7cb08a
  [0.49, 0.69, 0.64],  // seafoam       #7cb0a3
  [0.49, 0.62, 0.69],  // sky           #7c9eb0
  [0.49, 0.53, 0.69],  // periwinkle    #7c87b0
];
