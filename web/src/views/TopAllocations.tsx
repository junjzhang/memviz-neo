import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TopAllocation } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  data: TopAllocation[];
}

const columns: ColumnsType<TopAllocation> = [
  {
    title: "#",
    key: "index",
    width: 50,
    render: (_v, _r, i) => i + 1,
  },
  {
    title: "Size",
    dataIndex: "size",
    width: 110,
    sorter: (a, b) => a.size - b.size,
    defaultSortOrder: "descend",
    render: (v: number) => formatBytes(v),
  },
  {
    title: "Type",
    dataIndex: "segment_type",
    width: 80,
  },
  {
    title: "Source",
    dataIndex: "source",
    ellipsis: true,
    render: (v: string | null) => (
      <span style={{ fontFamily: "monospace", fontSize: 12 }}>
        {v ?? "\u2014"}
      </span>
    ),
  },
  {
    title: "Address",
    dataIndex: "address",
    width: 140,
    render: (v: number) => (
      <span style={{ fontFamily: "monospace", fontSize: 12 }}>
        0x{v.toString(16)}
      </span>
    ),
  },
];

export default function TopAllocations({ data }: Props) {
  return (
    <Table
      columns={columns}
      dataSource={data}
      rowKey="address"
      size="small"
      pagination={{ pageSize: 20, showSizeChanger: true }}
      scroll={{ y: 500 }}
    />
  );
}
