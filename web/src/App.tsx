import { useCallback, useEffect, useTransition } from "react";
import { ConfigProvider, theme } from "antd";
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
        token: {
          colorPrimary: "#d9f99d",
          colorBgContainer: "#111113",
          colorBgElevated: "#111113",
          colorBorder: "#1f1f23",
          colorText: "#fafafa",
          colorTextSecondary: "#a1a1aa",
          borderRadius: 0,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
        },
      }}
    >
      {fileStatus !== "ready" ? <FileSelector /> : <Dashboard />}
    </ConfigProvider>
  );
}

function Section({
  eyebrow,
  title,
  meta,
  children,
}: {
  eyebrow?: string;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          {eyebrow && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--fg-dim)",
                letterSpacing: "0.14em",
              }}
            >
              {eyebrow}
            </span>
          )}
          <h2 className="section-title">{title}</h2>
        </div>
        {meta && <div className="section-meta">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

function Empty({ label = "No data" }: { label?: string }) {
  return (
    <div
      style={{
        padding: "40px 0",
        textAlign: "center",
        color: "var(--fg-faint)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      — {label} —
    </div>
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

  const [, startTransition] = useTransition();
  const selectRank = useCallback(
    (r: number) => startTransition(() => setCurrentRank(r)),
    [setCurrentRank],
  );

  const [tlRef, tlWidth] = useContainerWidth();
  const [gridRef, gridWidth] = useContainerWidth();
  const halfWidth = gridWidth > 0 ? Math.floor((gridWidth - 32) / 2) : 600;
  const rankTag = `R${String(currentRank).padStart(2, "0")}`;

  return (
    <Layout>
      <div className="page">
        {error && (
          <div
            className="mono"
            style={{
              color: "var(--red)",
              padding: "12px 16px",
              border: "1px solid #7f1d1d",
              background: "rgba(248,113,113,0.05)",
              marginBottom: 24,
              fontSize: 12,
            }}
          >
            ! {error}
          </div>
        )}

        <Section
          eyebrow="01"
          title="Multi-Rank Overview"
          meta={`${multiRankOverview.length} ranks`}
        >
          <MultiRank
            data={multiRankOverview}
            currentRank={currentRank}
            onSelectRank={selectRank}
          />
        </Section>

        <div ref={tlRef}>
          <Section
            eyebrow="02"
            title="Memory Timeline"
            meta={
              <>
                <span className="mono hl">{rankTag}</span>
                <span className="mono faint" style={{ marginLeft: 12 }}>
                  {timelineBlocks.length} blocks
                </span>
              </>
            }
          >
            {timeline && tlWidth > 0 ? (
              <PhaseTimeline
                data={timeline}
                blocks={timelineBlocks}
                anomalies={anomalies}
                width={tlWidth}
                height={520}
                currentRank={currentRank}
              />
            ) : (
              <Empty />
            )}
          </Section>
        </div>

        {anomalies.length > 0 && (
          <Section
            eyebrow="03"
            title="Anomalies"
            meta={
              <span className="mono" style={{ color: "var(--red)" }}>
                {anomalies.length} detected
              </span>
            }
          >
            <AnomalyPanel anomalies={anomalies} />
          </Section>
        )}

        <div
          ref={gridRef}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 32,
            marginBottom: 56,
          }}
        >
          <section>
            <div className="section-head">
              <h2 className="section-title">
                <span
                  className="mono"
                  style={{
                    color: "var(--fg-dim)",
                    letterSpacing: "0.14em",
                    marginRight: 12,
                  }}
                >
                  04
                </span>
                Memory Treemap
              </h2>
              <span className="section-meta mono hl">{rankTag}</span>
            </div>
            {treemap && halfWidth > 0 ? (
              <Treemap data={treemap} width={halfWidth} height={450} />
            ) : (
              <Empty />
            )}
          </section>

          <section>
            <div className="section-head">
              <h2 className="section-title">
                <span
                  className="mono"
                  style={{
                    color: "var(--fg-dim)",
                    letterSpacing: "0.14em",
                    marginRight: 12,
                  }}
                >
                  05
                </span>
                Address Space
              </h2>
              <span className="section-meta mono hl">{rankTag}</span>
            </div>
            <div style={{ maxHeight: 460, overflow: "auto" }}>
              {segments.length > 0 && halfWidth > 0 ? (
                <AddressMap segments={segments} width={halfWidth} />
              ) : (
                <Empty />
              )}
            </div>
          </section>
        </div>

        <Section
          eyebrow="06"
          title="Top Allocations"
          meta={<span className="mono hl">{rankTag}</span>}
        >
          <TopAllocations data={topAllocations} />
        </Section>
      </div>
    </Layout>
  );
}
