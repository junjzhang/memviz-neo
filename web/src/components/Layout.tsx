import type { ReactNode } from "react";
import { Layout as AntLayout, Select, Spin } from "antd";
import { useDataStore } from "../stores/dataStore";
import { formatBytes } from "../utils";

const { Header, Content } = AntLayout;

export default function Layout({ children }: { children: ReactNode }) {
  const { ranks, currentRank, summary, loading, setCurrentRank } =
    useDataStore();

  return (
    <AntLayout style={{ minHeight: "100vh", background: "#0a0a0a" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          background: "#141414",
          borderBottom: "1px solid #303030",
          padding: "0 24px",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 16, color: "#fff" }}>
          memviz-neo
        </span>
        <Select
          value={currentRank}
          onChange={setCurrentRank}
          style={{ width: 110 }}
          options={ranks.map((r) => ({ label: `Rank ${r}`, value: r }))}
        />
        {summary && (
          <div style={{ display: "flex", gap: 16, marginLeft: "auto", color: "#888", fontSize: 13 }}>
            <span>
              Active: {formatBytes(summary.active_bytes)}
            </span>
            <span>
              Inactive: {formatBytes(summary.inactive_bytes)}
            </span>
            <span>
              {formatBytes(summary.total_allocated)} / {formatBytes(summary.total_reserved)}
            </span>
          </div>
        )}
      </Header>
      <Content style={{ padding: 20 }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 100 }}>
            <Spin size="large" />
          </div>
        ) : (
          children
        )}
      </Content>
    </AntLayout>
  );
}
