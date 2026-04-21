import { useEffect, useRef } from "react";

type Range = [number, number];
type RangeRef = React.MutableRefObject<Range>;
type ManualYRef = React.MutableRefObject<Range | null>;

interface NavOpts {
  keysDownRef: React.MutableRefObject<Set<string>>;
  viewRangeRef: RangeRef;
  yRangeRef: RangeRef;
  manualYRangeRef: ManualYRef;
  peakBytes: number;
  timeMin: number;
  timeMax: number;
  xAxisMode: "time" | "event";
  totalXRange: number;
  invalidate: () => void;
}

/**
 * Continuous smooth pan/zoom via rAF while WASD / arrow keys are held.
 * - Plain WASD / arrows: pan/zoom the X axis.
 * - Shift+WS / Shift+↑↓:  zoom Y around the view center.
 * - Shift+AD / Shift+←→:  pan Y.
 * Writes viewRangeRef / manualYRangeRef directly; the render loop picks
 * up the mutation and repaints. Restarts when the axis basis (mode,
 * bounds) changes so the new bounds apply next frame.
 */
export function useNavigation({
  keysDownRef, viewRangeRef, yRangeRef, manualYRangeRef,
  peakBytes, timeMin, timeMax, xAxisMode, totalXRange, invalidate,
}: NavOpts) {
  const rafRef = useRef<number>(0);

  useEffect(() => {
    let running = true;

    function tick() {
      if (!running) return;
      const keys = keysDownRef.current;
      const shift = keys.has("shift");
      const hasYZoom = shift && (keys.has("w") || keys.has("s") || keys.has("arrowup") || keys.has("arrowdown"));
      const hasYPan  = shift && (keys.has("a") || keys.has("d") || keys.has("arrowleft") || keys.has("arrowright"));
      const hasXNav = !shift && (keys.has("a") || keys.has("d") || keys.has("w") || keys.has("s")
        || keys.has("arrowleft") || keys.has("arrowright") || keys.has("arrowup") || keys.has("arrowdown"));

      if (hasYZoom) {
        // Shift+W/S → zoom Y around the view center. Seeds the manual
        // range from current auto-fit on first use.
        const zoomRate = 0.97;
        const cur = manualYRangeRef.current ?? [yRangeRef.current[0], yRangeRef.current[1]];
        const [yMin0, yMax0] = cur;
        const span = yMax0 - yMin0;
        const c = (yMin0 + yMax0) / 2;
        const peakCap = (peakBytes || yMax0) * 1.1;
        let nYMin = yMin0, nYMax = yMax0;
        if (keys.has("w") || keys.has("arrowup")) {
          const ns = span * zoomRate;
          if (ns > Math.max(1, peakCap * 0.001)) {
            nYMin = Math.max(0, c - ns / 2);
            nYMax = nYMin + ns;
          }
        }
        if (keys.has("s") || keys.has("arrowdown")) {
          const ns = Math.min(peakCap, span / zoomRate);
          nYMin = Math.max(0, c - ns / 2);
          nYMax = Math.min(peakCap, nYMin + ns);
        }
        if (nYMin !== yMin0 || nYMax !== yMax0) {
          manualYRangeRef.current = [nYMin, nYMax];
          invalidate();
        }
      }

      if (hasYPan) {
        // Shift+A/D → pan Y. D scrolls toward larger bytes, A toward the
        // baseline. Seeds from auto-fit on first use.
        const cur = manualYRangeRef.current ?? [yRangeRef.current[0], yRangeRef.current[1]];
        const [yMin0, yMax0] = cur;
        const span = yMax0 - yMin0;
        const peakCap = (peakBytes || yMax0) * 1.1;
        const panRate = span * 0.02;
        let nYMin = yMin0, nYMax = yMax0;
        if (keys.has("d") || keys.has("arrowright")) {
          nYMax = Math.min(peakCap, yMax0 + panRate);
          nYMin = nYMax - span;
        }
        if (keys.has("a") || keys.has("arrowleft")) {
          nYMin = Math.max(0, yMin0 - panRate);
          nYMax = nYMin + span;
        }
        if (nYMin !== yMin0 || nYMax !== yMax0) {
          manualYRangeRef.current = [nYMin, nYMax];
          invalidate();
        }
      }

      if (hasXNav) {
        const [tMin, tMax] = viewRangeRef.current;
        const range = tMax - tMin;
        const absMin = xAxisMode === "event" ? 0 : timeMin;
        const absMax = xAxisMode === "event" ? totalXRange : timeMax;
        const fullRange = absMax - absMin;
        const panRate = range * 0.02;
        const zoomRate = 0.97;
        const minRange = xAxisMode === "event" ? 1 : 100;
        let newMin = tMin, newMax = tMax;

        if (keys.has("a") || keys.has("arrowleft")) {
          newMin = Math.max(absMin, tMin - panRate);
          newMax = newMin + range;
        }
        if (keys.has("d") || keys.has("arrowright")) {
          newMax = Math.min(absMax, tMax + panRate);
          newMin = newMax - range;
        }
        if (keys.has("w") || keys.has("arrowup")) {
          const nr = range * zoomRate;
          if (nr > minRange) {
            const c = (newMin + newMax) / 2;
            newMin = Math.max(absMin, c - nr / 2);
            newMax = Math.min(absMax, newMin + nr);
          }
        }
        if (keys.has("s") || keys.has("arrowdown")) {
          const nr = Math.min(fullRange, range / zoomRate);
          const c = (newMin + newMax) / 2;
          newMin = Math.max(absMin, c - nr / 2);
          newMax = Math.min(absMax, newMin + nr);
        }

        if (newMin !== tMin || newMax !== tMax) {
          viewRangeRef.current = [newMin, newMax];
          invalidate();
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
    // peakBytes + refs are imperative plumbing — re-running on their
    // identity would reset the loop on every rank swap mid-keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMin, timeMax, xAxisMode, totalXRange]);
}
