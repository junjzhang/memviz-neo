interface Props {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}

/** "x–y / total · ← →" — shared paging control for data tables. */
export default function TablePager({ page, total, pageSize, onChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * pageSize + 1;
  const end = Math.min((safePage + 1) * pageSize, total);
  const btnStyle = { padding: "4px 12px", fontSize: 11 };
  return (
    <>
      <span className="mono faint" style={{ fontSize: 11 }}>
        {start}–{end} / {total}
      </span>
      <button
        className="btn"
        style={btnStyle}
        disabled={safePage === 0}
        onClick={() => onChange(Math.max(0, safePage - 1))}
      >
        ←
      </button>
      <button
        className="btn"
        style={btnStyle}
        disabled={safePage >= totalPages - 1}
        onClick={() => onChange(Math.min(totalPages - 1, safePage + 1))}
      >
        →
      </button>
    </>
  );
}
