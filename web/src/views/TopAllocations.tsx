import { useMemo, useState } from "react";
import type { TopAllocation } from "../types/snapshot";
import { formatBytes, formatTopFrame } from "../utils";
import { useDataStore } from "../stores/dataStore";

interface Props {
  data: TopAllocation[];
}

type SortKey = "size" | "segment_type";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 20;

export default function TopAllocations({ data }: Props) {
  const framePool = useDataStore((s) => s.framePool);
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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

  return (
    <div>
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
                onClick={() => toggleSort("segment_type")}
              >
                Type {sortArrow("segment_type")}
              </th>
              <th>Source</th>
              <th style={{ width: 160 }}>Address</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map((row, i) => (
              <tr key={row.address}>
                <td className="mono faint">{page * PAGE_SIZE + i + 1}</td>
                <td className="mono" style={{ color: "var(--fg)" }}>
                  {formatBytes(row.size)}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  <span className="chip">{row.segment_type}</span>
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
                  {formatTopFrame(row.source_idx, framePool) || "—"}
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
          <span className="mono faint" style={{ fontSize: 11 }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} / {sorted.length}
          </span>
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 11 }}
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ←
          </button>
          <button
            className="btn"
            style={{ padding: "4px 12px", fontSize: 11 }}
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
