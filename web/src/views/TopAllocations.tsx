import { useMemo, useState } from "react";
import type { TopAllocation } from "../types/snapshot";
import { formatBytes, formatTopFrame } from "../utils";
import { useDataStore } from "../stores/dataStore";
import TablePager from "../components/TablePager";

interface Props {
  data: TopAllocation[];
  /** When set, only rows whose stack passes through this frame are shown.
   *  Driven by the Flamegraph's drill-in root. */
  frameFilter?: number | null;
  /** Frame label for the filter chip (drilled-into frame name). */
  frameFilterLabel?: string;
}

type SortKey = "size" | "lifetime_us";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 20;

export default function TopAllocations({
  data,
  frameFilter,
  frameFilterLabel,
}: Props) {
  const framePool = useDataStore((s) => s.framePool);
  const stackPool = useDataStore((s) => s.stackPool);
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (frameFilter == null || frameFilter < 0) return data;
    return data.filter((row) => {
      const stack = stackPool[row.stack_idx];
      if (!stack) return false;
      for (let i = 0; i < stack.length; i++) {
        if (stack[i] === frameFilter) return true;
      }
      return false;
    });
  }, [data, frameFilter, stackPool]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const pageData = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const sortArrow = (k: SortKey) =>
    k === sortKey ? (
      <span className="hl" style={{ marginLeft: 4 }}>
        {sortDir === "asc" ? "↑" : "↓"}
      </span>
    ) : null;

  const fmtLifetime = (row: TopAllocation) =>
    row.free_us === -1 ? "alive" : `${(row.lifetime_us / 1e6).toFixed(3)}s`;

  return (
    <div>
      {frameFilter != null && frameFilter >= 0 && (
        <div className="topallocs-filter mono">
          <span className="eyebrow">filtered by stack</span>
          <span className="topallocs-filter-frame">{frameFilterLabel || "?"}</span>
          <span className="faint">
            · {filtered.length} of {data.length} · clear via "All" in flamegraph
          </span>
        </div>
      )}
      <div className="dtable-scroll">
        <table className="dtable">
          <thead>
            <tr>
              <th style={{ width: 50 }}>#</th>
              <th
                style={{ width: 120, cursor: "pointer", userSelect: "none" }}
                onClick={() => toggleSort("size")}
              >
                Size {sortArrow("size")}
              </th>
              <th
                style={{ width: 110, cursor: "pointer", userSelect: "none" }}
                onClick={() => toggleSort("lifetime_us")}
              >
                Lifetime {sortArrow("lifetime_us")}
              </th>
              <th>Source</th>
              <th style={{ width: 160 }}>Address</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map((row, i) => (
              <tr key={`${row.address}-${row.alloc_us}`}>
                <td className="mono faint">{safePage * PAGE_SIZE + i + 1}</td>
                <td className="mono" style={{ color: "var(--fg)" }}>
                  {formatBytes(row.size)}
                </td>
                <td
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: row.free_us === -1 ? "var(--red)" : "var(--fg-muted)",
                  }}
                >
                  {fmtLifetime(row)}
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
                >
                  {formatTopFrame(row.top_frame_idx, framePool) || "—"}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  0x{row.address.toString(16)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            paddingTop: 12,
          }}
        >
          <TablePager
            page={safePage}
            total={sorted.length}
            pageSize={PAGE_SIZE}
            onChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
