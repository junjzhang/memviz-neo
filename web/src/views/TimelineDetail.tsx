// Selection detail — renders the "Size / Duration / Address / Segment"
// stats row + call stack for whichever alloc is currently selected. Lives
// below the Segment Timeline so the two plots sit flush against each
// other. Reads selection state from dataStore; no props.

import { useEffect, useState } from "react";
import { useDataStore } from "../stores/dataStore";
import type { AllocationDetail } from "../types/timeline";
import { formatBytes, isInternalFrame } from "../utils";

export function TimelineHints() {
  return (
    <div className="tl-hint mono">
      <Kbd>WASD</Kbd>
      <span>pan/zoom X</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>⇧WASD</Kbd>
      <span>pan/zoom Y</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>R</Kbd><span>+drag</span>
      <span>mem ruler</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>T</Kbd><span>+drag</span>
      <span>time ruler</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>drag</Kbd>
      <span>zoom to box</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>dblclick</Kbd>
      <span>reset</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>Esc</Kbd>
      <span>clear</span>
      <span className="tl-hint-sep">·</span>
      <Kbd>⌘C</Kbd>
      <span>copy trace</span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="tl-kbd">{children}</kbd>;
}

export function TimelineDetailPanel() {
  const selectedAlloc = useDataStore((s) => s.selectedAlloc);
  const currentRank = useDataStore((s) => s.currentRank);
  const segments = useDataStore((s) => s.segments);
  const getDetail = useDataStore((s) => s.getDetail);
  const [detail, setDetail] = useState<AllocationDetail | null>(null);

  useEffect(() => {
    if (!selectedAlloc) {
      setDetail(null);
      return;
    }
    setDetail(getDetail(currentRank, selectedAlloc.addr, selectedAlloc.alloc_us));
  }, [selectedAlloc, currentRank, getDetail]);

  // Cmd/Ctrl+C: copy stack trace. Kept here (not in PhaseTimeline) so it
  // tracks the detail panel that's actually visible to the user.
  useEffect(() => {
    if (!detail) return;
    const onCopy = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      // Don't hijack ⌘C inside inputs / editable fields.
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      const trace = detail.frames
        .filter((f) => !isInternalFrame(f))
        .map((f) => `${f.name} @ ${f.filename}:${f.line}`)
        .join("\n");
      navigator.clipboard.writeText(`${formatBytes(detail.size)} 0x${detail.addr.toString(16)}\n${trace}`);
      e.preventDefault();
    };
    window.addEventListener("keydown", onCopy);
    return () => window.removeEventListener("keydown", onCopy);
  }, [detail]);

  if (!detail) return null;

  const seg = (() => {
    for (const s of segments) {
      if (detail.addr >= s.address && detail.addr < s.address + s.total_size) {
        return { address: s.address, total: s.total_size, offset: detail.addr - s.address };
      }
    }
    return null;
  })();

  return (
    <div className="tl-detail">
      <div className="tl-detail-head">
        <div className="stat">
          <span className="stat-label">Size</span>
          <span className="stat-value" style={{ fontSize: 18 }}>{formatBytes(detail.size)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Duration</span>
          <span className="stat-value" style={{ fontSize: 18 }}>
            {detail.free_us === -1
              ? "alive"
              : `${((detail.free_us - detail.alloc_us) / 1e6).toFixed(4)}s`}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Address</span>
          <span className="stat-value mono" style={{ fontSize: 14 }}>
            0x{detail.addr.toString(16)}
          </span>
        </div>
        {seg && (
          <div className="stat">
            <span className="stat-label">Segment</span>
            <span className="stat-value mono" style={{ fontSize: 14 }}>
              0x{seg.address.toString(16)}
              <span className="faint" style={{ marginLeft: 6, fontSize: 11 }}>
                +{formatBytes(seg.offset)} / {formatBytes(seg.total)}
              </span>
            </span>
          </div>
        )}
        <div
          className="eyebrow"
          style={{ marginLeft: "auto", alignSelf: "flex-end" }}
        >
          ⌘C copy trace
        </div>
      </div>
      <div className="tl-detail-trace mono">
        {detail.frames
          .filter((f) => !isInternalFrame(f))
          .map((f, i) => {
            const isPython = f.filename.includes(".py");
            return (
              <div key={i} className="tl-stack-frame" data-py={isPython ? "1" : "0"}>
                <span className="tl-stack-name">
                  {f.name.length > 100 ? f.name.slice(0, 97) + "…" : f.name}
                </span>
                {f.filename && (
                  <span className="tl-stack-loc">
                    {" @ "}{f.filename.split("/").slice(-2).join("/")}:{f.line}
                  </span>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
