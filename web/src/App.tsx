import { useEffect } from "react";
import { ConfigProvider, theme, Card, Empty } from "antd";
import Layout from "./components/Layout";
import PhaseTimeline from "./views/PhaseTimeline";
import Treemap from "./views/Treemap";
import TopAllocations from "./views/TopAllocations";
import AddressMap from "./views/AddressMap";
import MultiRank from "./views/MultiRank";
import { useDataStore } from "./stores/dataStore";
import { useContainerWidth } from "./hooks/useContainerWidth";

export default function App() {
  const {
    treemap,
    topAllocations,
    segments,
    multiRankOverview,
    timeline,
    timelineBlocks,
    currentRank,
    error,
    fetchRanks,
    setCurrentRank,
  } = useDataStore();

  const [tlRef, tlWidth] = useContainerWidth();
  const [gridRef, gridWidth] = useContainerWidth();

  useEffect(() => {
    fetchRanks();
  }, [fetchRanks]);

  const halfWidth = gridWidth > 0 ? Math.floor((gridWidth - 16) / 2) - 24 : 600;

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { borderRadius: 6, colorBgContainer: "#141414" },
      }}
    >
      <Layout>
        {error && (
          <div style={{ color: "#ef4444", padding: 16 }}>Error: {error}</div>
        )}

        {/* Timeline — primary view */}
        <div ref={tlRef}>
          <Card
            title={`Memory Timeline — Rank ${currentRank}`}
            size="small"
            style={{ marginBottom: 16 }}
          >
            {timeline && tlWidth > 0 ? (
              <PhaseTimeline
                data={timeline}
                blocks={timelineBlocks}
                width={tlWidth - 48}
                height={500}
                currentRank={currentRank}
              />
            ) : (
              <Empty />
            )}
          </Card>
        </div>

        {/* Multi-Rank Overview */}
        <Card
          title="Multi-Rank Overview"
          size="small"
          style={{ marginBottom: 16 }}
        >
          <MultiRank
            data={multiRankOverview}
            currentRank={currentRank}
            onSelectRank={setCurrentRank}
          />
        </Card>

        <div
          ref={gridRef}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginBottom: 16,
          }}
        >
          {/* Treemap */}
          <Card title={`Memory Treemap — Rank ${currentRank}`} size="small">
            {treemap && halfWidth > 0 ? (
              <Treemap data={treemap} width={halfWidth} height={450} />
            ) : (
              <Empty />
            )}
          </Card>

          {/* Address Space Map */}
          <Card
            title={`Address Space — Rank ${currentRank}`}
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

        {/* Top Allocations */}
        <Card title={`Top Allocations — Rank ${currentRank}`} size="small">
          <TopAllocations data={topAllocations} />
        </Card>
      </Layout>
    </ConfigProvider>
  );
}
