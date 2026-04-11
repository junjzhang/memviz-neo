import type { Allocation } from "./index";
import { formatBytes } from "../utils";

export type AnomalyType = "pending_free" | "leak";

export interface Anomaly {
  type: AnomalyType;
  severity: number; // 0-1, higher = worse
  label: string;
  detail: string;
  addr: number;
  alloc_us: number;
  free_us: number; // -1 if alive
  size: number;
  top_frame: string;
}

const PENDING_FREE_THRESHOLD_US = 1000; // 1ms
const LEAK_MIN_SIZE = 1_048_576; // 1MB

export function detectAnomalies(allocations: Allocation[], timeMax: number): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const a of allocations) {
    // Long pending_free: user freed but CUDA events delayed completion
    if (a.free_requested_us > 0 && a.free_us > 0) {
      const pendingDuration = a.free_us - a.free_requested_us;
      if (pendingDuration > PENDING_FREE_THRESHOLD_US) {
        const totalLifetime = a.free_us - a.alloc_us;
        anomalies.push({
          type: "pending_free",
          severity: Math.min(1, pendingDuration / totalLifetime),
          label: `Pending ${(pendingDuration / 1000).toFixed(1)}ms`,
          detail: `${formatBytes(a.size)} stuck in pending_free for ${(pendingDuration / 1000).toFixed(1)}ms (${Math.round((pendingDuration / totalLifetime) * 100)}% of lifetime). Likely cross-stream sync delay.`,
          addr: a.addr,
          alloc_us: a.alloc_us,
          free_us: a.free_us,
          size: a.size,
          top_frame: a.top_frame,
        });
      }
    }

    // Leak suspects: alive at end, large
    if (a.free_us === -1 && a.size >= LEAK_MIN_SIZE) {
      const aliveFor = timeMax - a.alloc_us;
      anomalies.push({
        type: "leak",
        severity: Math.min(1, a.size / (1024 * 1024 * 1024)), // severity by size (up to 1GB)
        label: `Alive ${formatBytes(a.size)}`,
        detail: `${formatBytes(a.size)} allocated at ${((a.alloc_us) / 1e6).toFixed(3)}s, never freed (alive ${(aliveFor / 1e6).toFixed(2)}s). Check if this is intentional.`,
        addr: a.addr,
        alloc_us: a.alloc_us,
        free_us: -1,
        size: a.size,
        top_frame: a.top_frame,
      });
    }

  }

  anomalies.sort((a, b) => b.severity - a.severity);
  return anomalies;
}
