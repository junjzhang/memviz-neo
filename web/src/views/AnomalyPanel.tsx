import { useState } from "react";
import type { Anomaly } from "../compute";
import { useDataStore } from "../stores/dataStore";
import { formatBytes, formatTopFrame } from "../utils";
import TablePager from "../components/TablePager";

const TYPE_LABELS: Record<string, string> = {
  pending_free: "Pending Free",
  leak: "Leak Suspect",
};

const TYPE_CHIP: Record<string, string> = {
  pending_free: "chip chip-orange",
  leak: "chip chip-red",
};

const PAGE_SIZE = 20;

export default function AnomalyPanel({ anomalies }: { anomalies: Anomaly[] }) {
  const focusAnomaly = useDataStore((s) => s.focusAnomaly);
  const focusedAddr = useDataStore((s) => s.focusedAddr);
  const framePool = useDataStore((s) => s.framePool);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<"all" | "pending_free" | "leak">("all");

  if (anomalies.length === 0) return null;

  const filtered = filter === "all" ? anomalies : anomalies.filter((a) => a.type === filter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageData = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const leakCount = anomalies.filter((a) => a.type === "leak").length;
  const pendingCount = anomalies.length - leakCount;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 0 10px",
        }}
      >
        <FilterPill
          active={filter === "all"}
          onClick={() => { setFilter("all"); setPage(0); }}
          label="All"
          count={anomalies.length}
        />
        <FilterPill
          active={filter === "leak"}
          onClick={() => { setFilter("leak"); setPage(0); }}
          label="Leak"
          count={leakCount}
          tone="red"
        />
        <FilterPill
          active={filter === "pending_free"}
          onClick={() => { setFilter("pending_free"); setPage(0); }}
          label="Pending"
          count={pendingCount}
          tone="orange"
        />
        <div style={{ flex: 1 }} />
        <TablePager
          page={safePage}
          total={filtered.length}
          pageSize={PAGE_SIZE}
          onChange={setPage}
        />
      </div>
      <div style={{ borderTop: "1px solid var(--border)" }}>
        <table className="dtable">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Type</th>
              <th style={{ width: 90 }}>Size</th>
              <th style={{ width: 260 }}>Source</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map((a) => {
              const key = `${a.addr}-${a.alloc_us}`;
              const isSelected = focusedAddr === a.addr;
              return (
                <tr
                  key={key}
                  className={isSelected ? "is-selected" : ""}
                  style={{ cursor: "pointer" }}
                  onClick={() => focusAnomaly(a)}
                >
                  <td>
                    <span className={TYPE_CHIP[a.type] || "chip"}>
                      {TYPE_LABELS[a.type] || a.type}
                    </span>
                  </td>
                  <td className="mono" style={{ color: "var(--fg)" }}>
                    {formatBytes(a.size)}
                  </td>
                  <td
                    className="mono"
                    style={{
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 0,
                    }}
                    title={formatTopFrame(a.top_frame_idx, framePool) || "?"}
                  >
                    {formatTopFrame(a.top_frame_idx, framePool) || "?"}
                  </td>
                  <td
                    className="mono faint"
                    style={{
                      fontSize: 11,
                      whiteSpace: "normal",
                      lineHeight: 1.5,
                      color: "var(--fg-muted)",
                    }}
                  >
                    {a.detail || a.label}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "red" | "orange";
}) {
  const color =
    tone === "red" ? "var(--red)" : tone === "orange" ? "var(--orange)" : "var(--fg)";
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: active ? "var(--bg-elev)" : "transparent",
        border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
        color: active ? color : "var(--fg-muted)",
        fontFamily: "var(--font-display)",
        fontSize: 11,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        cursor: "pointer",
        transition: "all 120ms var(--ease)",
      }}
    >
      {label}
      <span
        className="mono"
        style={{
          fontSize: 10,
          color: active ? color : "var(--fg-faint)",
          letterSpacing: 0,
        }}
      >
        {count}
      </span>
    </button>
  );
}
