import { formatBytes } from "../../utils";
import { COLOR_ACCENT, FONT_MONO } from "../theme";

export type RulerType = "vertical" | "horizontal";
export interface Ruler {
  type: RulerType;
  startPx: { x: number; y: number };
  endPx: { x: number; y: number };
}

export interface SelRect { x1: number; y1: number; x2: number; y2: number }

export interface PlotBox { left: number; top: number; w: number; h: number }

function formatTime(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}µs`;
  if (us < 1e6) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1e6).toFixed(4)}s`;
}

/** Small accent pill used to label ruler endpoints / deltas. */
export function drawPill(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number) {
  ctx.font = FONT_MONO;
  const tw = ctx.measureText(text).width;
  const px = 6, py = 4;
  const rw = tw + px * 2, rh = 14 + py * 2;
  const rx = cx - rw / 2, ry = cy - rh / 2;
  ctx.fillStyle = COLOR_ACCENT;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.fillStyle = "#0a0a0b";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
  ctx.textBaseline = "alphabetic";
}

/**
 * Vertical ruler = measure bytes (ΔY). Horizontal ruler = measure time/events (ΔX).
 * Both paint dashed guides + an accent anchor line with endpoint pills.
 */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  ruler: Ruler,
  plot: PlotBox,
  xAxisMode: "time" | "event",
  timeMin: number,
  yToBytes: (y: number) => number,
  xToTime: (x: number) => number,
) {
  const { type, startPx, endPx } = ruler;
  ctx.save(); ctx.lineWidth = 1.5;
  if (type === "vertical") {
    const x = startPx.x, yTop = Math.min(startPx.y, endPx.y), yBot = Math.max(startPx.y, endPx.y);
    ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(217,249,157,0.4)";
    ctx.beginPath(); ctx.moveTo(plot.left, yTop); ctx.lineTo(plot.left + plot.w, yTop);
    ctx.moveTo(plot.left, yBot); ctx.lineTo(plot.left + plot.w, yBot); ctx.stroke();
    ctx.setLineDash([]); ctx.strokeStyle = COLOR_ACCENT;
    ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot);
    ctx.moveTo(x - 6, yTop); ctx.lineTo(x + 6, yTop); ctx.moveTo(x - 6, yBot); ctx.lineTo(x + 6, yBot); ctx.stroke();
    const bTop = yToBytes(yTop), bBot = yToBytes(yBot);
    drawPill(ctx, formatBytes(bTop), x + 50, yTop);
    drawPill(ctx, formatBytes(bBot), x + 50, yBot);
    drawPill(ctx, `Δ ${formatBytes(Math.abs(bTop - bBot))}`, x + 50, (yTop + yBot) / 2);
  } else {
    const y = startPx.y, xL = Math.min(startPx.x, endPx.x), xR = Math.max(startPx.x, endPx.x);
    ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(217,249,157,0.4)";
    ctx.beginPath(); ctx.moveTo(xL, plot.top); ctx.lineTo(xL, plot.top + plot.h);
    ctx.moveTo(xR, plot.top); ctx.lineTo(xR, plot.top + plot.h); ctx.stroke();
    ctx.setLineDash([]); ctx.strokeStyle = COLOR_ACCENT;
    ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y);
    ctx.moveTo(xL, y - 6); ctx.lineTo(xL, y + 6); ctx.moveTo(xR, y - 6); ctx.lineTo(xR, y + 6); ctx.stroke();
    const tL = xToTime(xL), tR = xToTime(xR), delta = Math.abs(tR - tL);
    const fmt = xAxisMode === "event"
      ? (v: number) => `#${Math.round(v).toLocaleString()}`
      : (v: number) => formatTime(v - timeMin);
    drawPill(ctx, fmt(tL), xL, y - 16);
    drawPill(ctx, fmt(tR), xR, y - 16);
    drawPill(
      ctx,
      xAxisMode === "event"
        ? `Δ ${Math.round(delta).toLocaleString()} evt`
        : `Δ ${formatTime(delta)}`,
      (xL + xR) / 2,
      y + 16,
    );
  }
  ctx.restore();
}

/** Zoom-selection box: dims the unselected area and strokes the marquee. */
export function drawSelectionRect(
  ctx: CanvasRenderingContext2D,
  selRect: SelRect,
  plot: PlotBox,
) {
  const sx1 = Math.min(selRect.x1, selRect.x2);
  const sy1 = Math.min(selRect.y1, selRect.y2);
  const sw = Math.abs(selRect.x2 - selRect.x1);
  const sh = Math.abs(selRect.y2 - selRect.y1);
  ctx.fillStyle = "rgba(10,10,11,0.55)";
  ctx.fillRect(plot.left, plot.top, plot.w, sy1 - plot.top);
  ctx.fillRect(plot.left, sy1 + sh, plot.w, plot.top + plot.h - sy1 - sh);
  ctx.fillRect(plot.left, sy1, sx1 - plot.left, sh);
  ctx.fillRect(sx1 + sw, sy1, plot.left + plot.w - sx1 - sw, sh);
  ctx.strokeStyle = COLOR_ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(sx1, sy1, sw, sh);
  ctx.setLineDash([]);
}
