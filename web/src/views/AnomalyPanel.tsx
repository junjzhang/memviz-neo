import { Table, Tag } from "antd";
import type { Anomaly } from "../compute";
import { useDataStore } from "../stores/dataStore";
import { formatBytes } from "../utils";

const TYPE_COLORS: Record<string, string> = {
  pending_free: "volcano",
  leak: "red",
};

const TYPE_LABELS: Record<string, string> = {
  pending_free: "Pending Free",
  leak: "Leak Suspect",
};

const columns = [
  {
    title: "Type",
    dataIndex: "type",
    width: 130,
    render: (t: string) => <Tag color={TYPE_COLORS[t]}>{TYPE_LABELS[t]}</Tag>,
    filters: [
      { text: "Pending Free", value: "pending_free" },
      { text: "Leak Suspect", value: "leak" },
    ],
    onFilter: (v: any, r: Anomaly) => r.type === v,
  },
  {
    title: "Size",
    dataIndex: "size",
    width: 100,
    render: (s: number) => formatBytes(s),
    sorter: (a: Anomaly, b: Anomaly) => a.size - b.size,
  },
  {
    title: "Info",
    dataIndex: "label",
    width: 140,
  },
  {
    title: "Source",
    dataIndex: "top_frame",
    ellipsis: true,
    render: (f: string) => <span style={{ fontFamily: "monospace", fontSize: 12 }}>{f || "?"}</span>,
  },
];

export default function AnomalyPanel({ anomalies }: { anomalies: Anomaly[] }) {
  const focusAnomaly = useDataStore((s) => s.focusAnomaly);
  const focusedAddr = useDataStore((s) => s.focusedAddr);

  if (anomalies.length === 0) return null;

  return (
    <Table
      dataSource={anomalies}
      columns={columns}
      rowKey={(r) => `${r.addr}-${r.alloc_us}`}
      size="small"
      pagination={{ pageSize: 10, size: "small", showSizeChanger: false }}
      scroll={{ y: 300 }}
      onRow={(record) => ({
        onClick: () => focusAnomaly(record),
        style: {
          cursor: "pointer",
          background: focusedAddr === record.addr ? "rgba(59,130,246,0.15)" : undefined,
        },
      })}
      expandable={{
        expandedRowRender: (r) => (
          <div style={{ fontFamily: "monospace", fontSize: 12, color: "#999", whiteSpace: "pre-wrap" }}>
            {r.detail}
          </div>
        ),
      }}
    />
  );
}
