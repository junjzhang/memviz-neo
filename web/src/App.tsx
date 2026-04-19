import { useCallback, useEffect, useRef } from "react";
import { ConfigProvider, theme } from "antd";
import Layout from "./components/Layout";
import FileSelector from "./components/FileSelector";
import PhaseTimeline from "./views/PhaseTimeline";
import MemoryFlamegraph from "./views/MemoryFlamegraph";
import TopAllocations from "./views/TopAllocations";
import AddressMap from "./views/AddressMap";
import MultiRank from "./views/MultiRank";
import AnomalyPanel from "./views/AnomalyPanel";
import SegmentTimeline from "./views/SegmentTimeline";
import { useDataStore } from "./stores/dataStore";
import { useFileStore } from "./stores/fileStore";
import { useRankSummaries } from "./stores/rankStore";
import { useContainerWidth, useViewportHeight } from "./hooks/useContainerWidth";

export default function App() {
  const fileStatus = useFileStore((s) => s.status);
  const setCurrentRank = useDataStore((s) => s.setCurrentRank);
  const hasCurrentRank = useDataStore((s) => s.summary !== null);
  // Pick whichever rank lands first — the K parse workers race and
  // rank 0 isn't guaranteed to finish first. Commit to that rank so
  // the dashboard appears as soon as any worker has something to show.
  const anyReadyRank = useRankSummaries((s) => {
    for (const key in s.summaries) return Number(key);
    return undefined;
  });

  useEffect(() => {
    if (fileStatus === "ready" && anyReadyRank !== undefined && !hasCurrentRank) {
      void setCurrentRank(anyReadyRank);
    }
  }, [fileStatus, anyReadyRank, hasCurrentRank, setCurrentRank]);

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

// Isolated subscriber: MultiRank re-renders on every progressive rank
// flush, but the rest of the dashboard shouldn't.
function MultiRankSection({ onSelectRank }: { onSelectRank: (r: number) => void }) {
  const currentRank = useDataStore((s) => s.currentRank);
  const allRanks = useFileStore((s) => s.ranks);
  const completedCount = useFileStore((s) => s.completedCount);
  const totalCount = useFileStore((s) => s.totalCount);
  const stillLoading = completedCount < totalCount;

  return (
    <Section
      eyebrow="01"
      title="Multi-Rank Overview"
      meta={
        stillLoading ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--accent)",
                animation: "fs-pulse 1.1s ease-in-out infinite",
              }}
            />
            <span className="mono hl">{completedCount}</span>
            <span className="faint">/ {totalCount} loading</span>
          </span>
        ) : (
          `${allRanks.length} ranks`
        )
      }
    >
      <MultiRank
        allRanks={allRanks}
        currentRank={currentRank}
        onSelectRank={onSelectRank}
      />
    </Section>
  );
}

function Dashboard() {
  // These selectors change on rank switch only, not on progressive load
  // flushes (ranks + completedCount live in MultiRankSection).
  const flame = useDataStore((s) => s.flame);
  const framePool = useDataStore((s) => s.framePool);
  const topAllocations = useDataStore((s) => s.topAllocations);
  const xAxisMode = useDataStore((s) => s.xAxisMode);
  const eventTimes = useDataStore((s) => s.eventTimes);
  const segments = useDataStore((s) => s.segments);
  const timeline = useDataStore((s) => s.timeline);
  const timelineAllocs = useDataStore((s) => s.timelineAllocs);
  const anomalies = useDataStore((s) => s.anomalies);
  const segmentRows = useDataStore((s) => s.segmentRows);
  const currentRank = useDataStore((s) => s.currentRank);
  const error = useDataStore((s) => s.error);
  const setCurrentRank = useDataStore((s) => s.setCurrentRank);

  const selectRank = useCallback(
    (r: number) => { void setCurrentRank(r); },
    [setCurrentRank],
  );

  const [tlRef, tlWidth] = useContainerWidth();
  const [gridRef, gridWidth] = useContainerWidth();
  const halfWidth = gridWidth > 0 ? Math.floor((gridWidth - 32) / 2) : 600;
  const rankTag = `R${String(currentRank).padStart(2, "0")}`;
  const tlHeight = useViewportHeight(560, 220);

  // Shared pan/zoom ref — PhaseTimeline + SegmentTimeline both
  // read/write every frame so they follow each other without re-renders.
  // Units track xAxisMode: μs in time mode, event index in event mode.
  const viewRangeRef = useRef<[number, number]>([0, 1]);
  useEffect(() => {
    if (!timeline) return;
    if (xAxisMode === "event") {
      const n = eventTimes ? eventTimes.length - 1 : 0;
      viewRangeRef.current = [0, Math.max(1, n)];
    } else {
      viewRangeRef.current = [timeline.time_min, timeline.time_max];
    }
  }, [timeline?.time_min, timeline?.time_max, xAxisMode, eventTimes]); // eslint-disable-line react-hooks/exhaustive-deps

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

        <MultiRankSection onSelectRank={selectRank} />

        <div ref={tlRef}>
          <Section
            eyebrow="02"
            title="Memory Timeline"
            meta={
              <>
                <span className="mono hl">{rankTag}</span>
                <span className="mono faint" style={{ marginLeft: 12 }}>
                  {timelineAllocs.length} allocs
                </span>
              </>
            }
          >
            {timeline && tlWidth > 0 ? (
              <PhaseTimeline
                data={timeline}
                allocs={timelineAllocs}
                anomalies={anomalies}
                width={tlWidth}
                height={tlHeight}
                currentRank={currentRank}
                viewRangeRef={viewRangeRef}
              />
            ) : (
              <Empty />
            )}
          </Section>

          {/* Allocator state timeline — same X axis as Memory Timeline,
              Y rows = allocator segments. Pan/zoom syncs via shared ref. */}
          {timeline && segmentRows.length > 0 && tlWidth > 0 && (
            <Section
              eyebrow="02b"
              title="Allocator Segments"
              meta={
                <>
                  <span className="mono hl">{rankTag}</span>
                  <span className="mono faint" style={{ marginLeft: 12 }}>
                    {segmentRows.length} segments
                  </span>
                </>
              }
            >
              <SegmentTimeline
                data={timeline}
                rows={segmentRows}
                width={tlWidth}
                height={Math.min(480, 24 + 36 + segmentRows.length * 26)}
                viewRangeRef={viewRangeRef}
                mode={xAxisMode}
                eventTimes={eventTimes}
              />
            </Section>
          )}
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
                Memory Flame Graph
              </h2>
              <span
                className="section-meta mono faint"
                title="bytes × lifetime contributed by allocations passing through each frame"
              >
                pressure by call stack
              </span>
            </div>
            {flame && flame.totalWeight > 0 && halfWidth > 0 ? (
              <MemoryFlamegraph flame={flame} framePool={framePool} width={halfWidth} height={450} />
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
