import type { FrameRecord } from "./types/snapshot";

/**
 * Frames the user doesn't care about: CUDA allocator internals, the
 * memory_snapshot capture shim, and frames with no source info. Mirrors
 * the Rust-side is_internal in wasm/src/lib.rs.
 */
export function isInternalFrame(f: FrameRecord): boolean {
  return (
    f.filename === "??" ||
    f.name.includes("CUDACachingAllocator") ||
    f.filename.includes("memory_snapshot")
  );
}

/**
 * Numeric preference backed by localStorage. Reads the key, rejects
 * anything that fails `validate`, and falls back to `fallback`.
 * `save` writes back; both handle missing localStorage (SSR / privacy
 * mode) and quota errors gracefully. Use inside stores / modules where
 * a hook isn't applicable; components should use usePersistedNumber.
 */
export function persistentNumber(
  key: string,
  fallback: number,
  validate: (n: number) => boolean = () => true,
) {
  const load = (): number => {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && validate(n) ? n : fallback;
  };
  const save = (n: number) => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(key, String(n)); } catch { /* ignore quota */ }
  };
  return { load, save };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val < 10 ? 2 : 1)} ${units[i]}`;
}

/**
 * Resolve a top_frame_idx against a frame pool to a display string.
 * Mirrors the old Rust top_frame() formatting: "name @ basename:line"
 * for Python, else a trimmed name. Returns "" if idx is -1 / out of
 * range (caller typically falls back to an address hex).
 */
export function formatTopFrame(idx: number, framePool: FrameRecord[] | undefined): string {
  if (!framePool || idx < 0 || idx >= framePool.length) return "";
  const f = framePool[idx];
  const name = f.name.split("(")[0].split("<")[0].trim();
  if (f.filename.includes(".py")) {
    const i = f.filename.lastIndexOf("/");
    const short = i >= 0 ? f.filename.slice(i + 1) : f.filename;
    return `${name} @ ${short}:${f.line}`;
  }
  return name.length > 60 ? name.slice(0, 57) + "..." : name;
}
