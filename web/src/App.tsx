import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, theme } from "antd";
import Layout from "./components/Layout";
import FileSelector from "./components/FileSelector";
import BottomTray, { type TrayTab } from "./components/BottomTray";
import PhaseTimeline from "./views/PhaseTimeline";
import MemoryFlamegraph from "./views/MemoryFlamegraph";
import TopAllocations from "./views/TopAllocations";
import RankSidebar from "./views/RankSidebar";
import AnomalyPanel from "./views/AnomalyPanel";
import SegmentTimeline from "./views/SegmentTimeline";
import { ShortcutsHint, TimelineDetailPanel } from "./views/TimelineDetail";
import { useDataStore } from "./stores/dataStore";
import { useFileStore } from "./stores/fileStore";
import { useRankSummaries } from "./stores/rankStore";
import { useContainerSize } from "./hooks/useContainerWidth";

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
  // These selectors change on rank switch only, not on progressive load
  // flushes (ranks + completedCount are subscribed inside RankSidebar).
  const flame = useDataStore((s) => s.flame);
  const framePool = useDataStore((s) => s.framePool);
  const topAllocations = useDataStore((s) => s.topAllocations);
  const xAxisMode = useDataStore((s) => s.xAxisMode);
  const eventTimes = useDataStore((s) => s.eventTimes);
  const timeline = useDataStore((s) => s.timeline);
  const timelineAllocs = useDataStore((s) => s.timelineAllocs);
  const anomalies = useDataStore((s) => s.anomalies);
  const segmentRows = useDataStore((s) => s.segmentRows);
  const currentRank = useDataStore((s) => s.currentRank);
  const error = useDataStore((s) => s.error);
  const setCurrentRank = useDataStore((s) => s.setCurrentRank);
  const selectedAlloc = useDataStore((s) => s.selectedAlloc);
  // Stable key the tray watches to auto-expand on selection. (addr,
  // alloc_us) identifies a unique alloc — picking a new one re-fires.
  const trayTrigger = selectedAlloc
    ? `${selectedAlloc.addr}-${selectedAlloc.alloc_us}`
    : null;

  const selectRank = useCallback(
    (r: number) => { void setCurrentRank(r); },
    [setCurrentRank],
  );

  // Box model: box contentH = Phase + Divider + Segment slot + chrome.
  // Phase and Segment slot share the available space; the divider
  // slides the split between them. Segment slot is height-capped — if
  // SegmentTimeline's natural canvas exceeds the slot, it scrolls
  // inside the slot (the box itself only scrolls when the tray is
  // expanded, via tl-tray-spacer).
  const [tlRef, tlWidth, trackH] = useContainerSize();
  const CHROME = 46; // track-head(~30) + tl-frame padding-top(8) + divider(8)
  const availableH = Math.max(300, Math.round(trackH - CHROME));
  const MIN_PHASE = 200;
  const MIN_SEGMENT = 80;
  const [phaseRatio, setPhaseRatio] = useState<number>(() => {
    const n = parseFloat(localStorage.getItem("phase-ratio") || "");
    return n > 0 && n < 1 ? n : 0.78;
  });
  const tlHeight = Math.max(
    MIN_PHASE,
    Math.min(availableH - MIN_SEGMENT, Math.round(availableH * phaseRatio)),
  );
  const segSlotHeight = availableH - tlHeight;

  useEffect(() => {
    localStorage.setItem("phase-ratio", phaseRatio.toFixed(3));
  }, [phaseRatio]);

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = tlHeight;
      const available = availableH;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(
          MIN_PHASE,
          Math.min(available - MIN_SEGMENT, startH + (ev.clientY - startY)),
        );
        setPhaseRatio(next / available);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [tlHeight, availableH],
  );

  const [mainView, setMainView] = useState<"timeline" | "flame">("timeline");
  // Flamegraph drill-in root, lifted up so the bottom Top Allocs can
  // filter to "stack contains this frame". -1 = "All" (no filter).
  const [flameRoot, setFlameRoot] = useState<{ idx: number; label: string }>({
    idx: -1,
    label: "",
  });
  const handleFlameRootChange = useCallback((idx: number, label: string) => {
    setFlameRoot({ idx, label });
  }, []);
  const rankTag = `R${String(currentRank).padStart(2, "0")}`;

  // Shared pan/zoom ref — PhaseTimeline + SegmentTimeline both
  // read/write every frame so they follow each other without re-renders.
  // Units track xAxisMode: μs in time mode, event index in event mode.
  const viewRangeRef = useRef<[number, number]>([0, 1]);
  if (import.meta.env.DEV) {
    const w = window as unknown as { __viewRange: unknown; __store: unknown };
    w.__viewRange = viewRangeRef;
    w.__store = useDataStore;
  }
  useEffect(() => {
    if (!timeline) return;
    if (xAxisMode === "event") {
      const n = eventTimes ? eventTimes.length - 1 : 0;
      viewRangeRef.current = [0, Math.max(1, n)];
    } else {
      viewRangeRef.current = [timeline.time_min, timeline.time_max];
    }
  }, [timeline?.time_min, timeline?.time_max, xAxisMode, eventTimes]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = useMemo<TrayTab[]>(() => {
    // Flamegraph mode: tray is the table extension of the flame view —
    // only Top Allocs, filtered by whatever frame the user drilled into.
    if (mainView === "flame") {
      return [
        {
          id: "top",
          label: "Top Allocs",
          badge: topAllocations.length || undefined,
          render: () => (
            <div className="tray-pad">
              <TopAllocations
                data={topAllocations}
                frameFilter={flameRoot.idx}
                frameFilterLabel={flameRoot.label}
              />
            </div>
          ),
        },
      ];
    }
    const list: TrayTab[] = [
      {
        id: "details",
        label: "Details",
        render: () => (
          <div className="tray-pad">
            <TimelineDetailPanel />
          </div>
        ),
      },
      {
        id: "top",
        label: "Top Allocs",
        badge: topAllocations.length || undefined,
        render: () => (
          <div className="tray-pad">
            <TopAllocations data={topAllocations} />
          </div>
        ),
      },
    ];
    if (anomalies.length > 0) {
      list.push({
        id: "anomalies",
        label: "Anomalies",
        badge: anomalies.length,
        render: () => (
          <div className="tray-pad">
            <AnomalyPanel anomalies={anomalies} />
          </div>
        ),
      });
    }
    return list;
  }, [mainView, topAllocations, anomalies, flameRoot]);

  return (
    <Layout>
      <div className="dashboard">
        <RankSidebar onSelectRank={selectRank} />
        <div className="dashboard-main">
          {error && <div className="dashboard-error mono">! {error}</div>}
          <div ref={tlRef} className="track timeline-track">
            <div className="track-head mono">
              <div className="main-view-tabs">
                <button
                  className={mainView === "timeline" ? "is-active" : ""}
                  onClick={() => setMainView("timeline")}
                >
                  Memory Timeline
                </button>
                <button
                  className={mainView === "flame" ? "is-active" : ""}
                  onClick={() => setMainView("flame")}
                >
                  Flamegraph
                </button>
              </div>
              <span className="track-head-right">
                <span className="hl">{rankTag}</span>
                {mainView === "timeline" ? (
                  <>
                    <span className="faint"> · {timelineAllocs.length} allocs</span>
                    {segmentRows.length > 0 && (
                      <span className="faint"> · {segmentRows.length} segments</span>
                    )}
                    <ShortcutsHint />
                  </>
                ) : (
                  flame && <span className="faint"> · {flame.totalWeight.toLocaleString()} bytes</span>
                )}
              </span>
            </div>
            {mainView === "timeline" ? (
              <div className="tl-frame">
                <div
                  className="tl-phase-slot"
                  style={{ height: tlHeight }}
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
                </div>
                {segmentRows.length > 0 && timeline && tlWidth > 0 && (
                  <>
                    <div
                      className="tl-divider"
                      onMouseDown={handleDividerMouseDown}
                      title="Drag to resize memory / segment split"
                    />
                    <div
                      className="tl-segment-slot"
                      style={{ height: segSlotHeight }}
                    >
                      <SegmentTimeline
                        data={timeline}
                        rows={segmentRows}
                        width={tlWidth}
                        height={segSlotHeight}
                        viewRangeRef={viewRangeRef}
                        mode={xAxisMode}
                        eventTimes={eventTimes}
                      />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div
                className="flame-main"
                style={{ height: availableH }}
              >
                {flame && flame.totalWeight > 0 && tlWidth > 0 ? (
                  <MemoryFlamegraph
                    flame={flame}
                    framePool={framePool}
                    width={tlWidth}
                    height={availableH}
                    onRootChange={handleFlameRootChange}
                  />
                ) : (
                  <Empty />
                )}
              </div>
            )}
            {/* Spacer grows with tray height so timeline-track overflows
                and becomes scrollable — lets users pull timeline content
                out from under the floating tray. Shrinks to 0 when the
                tray is collapsed so no scroll appears at rest. */}
            <div className="tl-tray-spacer" />
          </div>
          <BottomTray
            tabs={tabs}
            defaultActiveId="details"
            expandTrigger={trayTrigger}
            expandActiveId="details"
          />
        </div>
      </div>
    </Layout>
  );
}

