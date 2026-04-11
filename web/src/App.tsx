import { useEffect } from "react";
import { ConfigProvider, theme, Card, Empty } from "antd";
import Layout from "./components/Layout";
import FileSelector from "./components/FileSelector";
import PhaseTimeline from "./views/PhaseTimeline";
import Treemap from "./views/Treemap";
import TopAllocations from "./views/TopAllocations";
import AddressMap from "./views/AddressMap";
import MultiRank from "./views/MultiRank";
import AnomalyPanel from "./views/AnomalyPanel";
import { useDataStore } from "./stores/dataStore";
import { useFileStore } from "./stores/fileStore";
import { useContainerWidth } from "./hooks/useContainerWidth";

export default function App() {
  const fileStatus = useFileStore((s) => s.status);
  const fileRankCount = useFileStore((s) => s.rankData.size);
  const loadFromFiles = useDataStore((s) => s.loadFromFiles);

  // Push data to dataStore only when rank count changes (not every flush)
  useEffect(() => {
    if (fileStatus === "ready" && fileRankCount > 0) {
      loadFromFiles(useFileStore.getState().rankData);
    }
  }, [fileStatus, fileRankCount, loadFromFiles]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { borderRadius: 6, colorBgContainer: "#141414" },
      }}
    >
      {fileStatus !== "ready" ? <FileSelector /> : <Dashboard />}
    </ConfigProvider>
  );
}

function Dashboard() {
  const {
    treemap,
    topAllocations,
    segments,
    multiRankOverview,
    timeline,
    timelineBlocks,
    anomalies,
    currentRank,
    error,
    setCurrentRank,
  } = useDataStore();

  const [tlRef, tlWidth] = useContainerWidth();
  const [gridRef, gridWidth] = useContainerWidth();
  const halfWidth = gridWidth > 0 ? Math.floor((gridWidth - 16) / 2) - 24 : 600;

  return (
    <Layout>
      {error && (
        <div style={{ color: "#ef4444", padding: 16 }}>Error: {error}</div>
      )}

      <Card title="Multi-Rank Overview" size="small" style={{ marginBottom: 16 }}>
        <MultiRank
          data={multiRankOverview}
          currentRank={currentRank}
          onSelectRank={setCurrentRank}
        />
      </Card>

      <div ref={tlRef}>
        <Card
          title={`Memory Timeline \u2014 Rank ${currentRank}`}
          size="small"
          style={{ marginBottom: 16 }}
        >
          {timeline && tlWidth > 0 ? (
            <PhaseTimeline
              data={timeline}
              blocks={timelineBlocks}
              anomalies={anomalies}
              width={tlWidth - 48}
              height={500}
              currentRank={currentRank}
            />
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      {anomalies.length > 0 && (
        <Card
          title={`Anomalies (${anomalies.length})`}
          size="small"
          style={{ marginBottom: 16 }}
        >
          <AnomalyPanel anomalies={anomalies} />
        </Card>
      )}

      <div
        ref={gridRef}
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}
      >
        <Card title={`Memory Treemap \u2014 Rank ${currentRank}`} size="small">
          {treemap && halfWidth > 0 ? (
            <Treemap data={treemap} width={halfWidth} height={450} />
          ) : (
            <Empty />
          )}
        </Card>

        <Card
          title={`Address Space \u2014 Rank ${currentRank}`}
          size="small"
          style={{ overflow: "auto" }}
        >
          {segments.length > 0 && halfWidth > 0 ? (
            <AddressMap segments={segments} width={halfWidth} />
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      <Card title={`Top Allocations \u2014 Rank ${currentRank}`} size="small">
        <TopAllocations data={topAllocations} />
      </Card>
    </Layout>
  );
}
