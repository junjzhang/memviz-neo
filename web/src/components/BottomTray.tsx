// Perfetto-style bottom tray: tab bar + resizable content pane. Tabs
// can advertise a scope (selection/global) and a badge. The handle on
// the top edge drags to resize; double-click collapses to just the tab
// bar. Height is persisted to localStorage so the layout survives
// reloads.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type TrayScope = "selection" | "global";

export interface TrayTab {
  id: string;
  label: string;
  scope?: {
    value: TrayScope;
    options?: TrayScope[];
    onChange?: (s: TrayScope) => void;
  };
  badge?: number | string;
  render: () => ReactNode;
}

interface Props {
  tabs: TrayTab[];
  defaultActiveId?: string;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  storageKey?: string;
  /** When this key changes, auto-expand the tray if currently collapsed
   *  and optionally switch to `expandActiveId`. Used to wake up the
   *  details view on a timeline selection. */
  expandTrigger?: string | number | null;
  expandActiveId?: string;
}

const TAB_BAR_H = 34;

export default function BottomTray({
  tabs,
  defaultActiveId,
  defaultHeight = 360,
  minHeight = TAB_BAR_H,
  maxHeight = 900,
  storageKey = "tray-height",
  expandTrigger,
  expandActiveId,
}: Props) {
  const [activeId, setActiveId] = useState<string | undefined>(
    defaultActiveId ?? tabs[0]?.id,
  );
  // First-time visit starts collapsed so the timeline gets the full
  // viewport height. Resize + localStorage then takes over and is
  // respected on subsequent loads.
  const [height, setHeight] = useState(() => {
    if (typeof window === "undefined") return TAB_BAR_H;
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return TAB_BAR_H;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? clamp(n, minHeight, maxHeight) : TAB_BAR_H;
  });
  const collapsed = height <= TAB_BAR_H + 2;

  // Auto-expand on external trigger (e.g. user clicked an alloc in the
  // timeline). Only fires when the tray is collapsed — a user who has
  // already resized it stays at whatever height they picked, and the
  // active tab isn't force-switched out from under them.
  const lastTriggerRef = useRef(expandTrigger);
  useEffect(() => {
    if (expandTrigger == null) {
      lastTriggerRef.current = expandTrigger;
      return;
    }
    if (expandTrigger === lastTriggerRef.current) return;
    lastTriggerRef.current = expandTrigger;
    setHeight((prev) => {
      if (prev > TAB_BAR_H + 2) return prev;
      if (expandActiveId && tabs.some((t) => t.id === expandActiveId)) {
        setActiveId(expandActiveId);
      }
      return defaultHeight;
    });
  }, [expandTrigger, expandActiveId, defaultHeight, tabs]);

  // If the active tab disappears (e.g. Anomalies count dropped to 0 and
  // we filter the list), fall back to the first visible tab.
  useEffect(() => {
    if (activeId && tabs.some((t) => t.id === activeId)) return;
    setActiveId(tabs[0]?.id);
  }, [tabs, activeId]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(height));
    } catch {
      /* quota / private mode — ignore */
    }
    // Publish so the timeline-track can reserve matching bottom padding
    // — lets the user scroll content out from under the float tray.
    document.documentElement.style.setProperty("--tray-reserve", `${height}px`);
  }, [height, storageKey]);

  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty("--tray-reserve");
    };
  }, []);

  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { y: e.clientY, h: height };
      const onMove = (ev: MouseEvent) => {
        const s = dragRef.current;
        if (!s) return;
        setHeight(clamp(s.h + (s.y - ev.clientY), minHeight, maxHeight));
      };
      const onUp = () => {
        dragRef.current = null;
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
    [height, minHeight, maxHeight],
  );

  const toggleCollapsed = useCallback(() => {
    setHeight((prev) => (prev <= TAB_BAR_H + 2 ? defaultHeight : TAB_BAR_H));
  }, [defaultHeight]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="tray" style={{ height }}>
      <div
        className="tray-handle"
        onMouseDown={onHandleMouseDown}
        onDoubleClick={toggleCollapsed}
        title="Drag to resize · double-click to collapse"
      />
      <div className="tray-tabs">
        {tabs.map((t) => {
          const isActive = t.id === active?.id;
          return (
            <button
              key={t.id}
              className={"tray-tab" + (isActive ? " is-active" : "")}
              onClick={() => {
                if (!isActive) setActiveId(t.id);
                if (collapsed) setHeight(defaultHeight);
              }}
            >
              <span>{t.label}</span>
              {t.scope && (
                <ScopeChip
                  scope={t.scope.value}
                  options={t.scope.options}
                  onChange={t.scope.onChange}
                />
              )}
              {t.badge !== undefined && t.badge !== 0 && t.badge !== "" && (
                <span className="tray-tab-badge">{t.badge}</span>
              )}
            </button>
          );
        })}
        <button
          className="tray-collapse"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▲" : "▼"}
        </button>
      </div>
      {!collapsed && active && (
        <div className="tray-body">{active.render()}</div>
      )}
      <style>{`
        .tray {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg-elev);
          border-top: 1px solid var(--border);
          box-shadow: 0 -6px 24px -12px rgba(0,0,0,0.6);
          z-index: 20;
        }
        .tray-handle {
          position: absolute;
          top: -3px;
          left: 0;
          right: 0;
          height: 7px;
          cursor: ns-resize;
          z-index: 2;
        }
        .tray-handle::after {
          content: "";
          position: absolute;
          top: 3px;
          left: 50%;
          transform: translateX(-50%);
          width: 36px;
          height: 1px;
          background: var(--border-strong);
          transition: background 120ms ease;
        }
        .tray-handle:hover::after { background: var(--accent); }
        .tray-tabs {
          display: flex;
          align-items: stretch;
          height: ${TAB_BAR_H}px;
          min-height: ${TAB_BAR_H}px;
          border-bottom: 1px solid var(--divider);
          padding: 0 var(--s4);
          gap: 0;
          flex: 0 0 auto;
        }
        .tray-tab {
          appearance: none;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          padding: 0 14px;
          margin: 0;
          cursor: pointer;
          color: var(--fg-faint);
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .tray-tab:hover { color: var(--fg-muted); }
        .tray-tab.is-active {
          color: var(--fg);
          border-bottom-color: var(--accent);
        }
        .tray-tab-badge {
          font-size: 10px;
          color: var(--fg-faint);
          background: var(--bg-elev-2);
          padding: 1px 6px;
          font-variant-numeric: tabular-nums;
          letter-spacing: 0;
        }
        .tray-tab.is-active .tray-tab-badge { color: var(--fg-muted); }
        .tray-collapse {
          appearance: none;
          background: transparent;
          border: none;
          color: var(--fg-faint);
          cursor: pointer;
          margin-left: auto;
          padding: 0 var(--s3);
          font-size: 10px;
        }
        .tray-collapse:hover { color: var(--fg); }
        .tray-body {
          flex: 1 1 auto;
          overflow: auto;
        }
        .scope-chip {
          font-size: 9px;
          letter-spacing: 0.08em;
          color: var(--fg-faint);
          border: 1px solid var(--border);
          padding: 1px 5px;
          line-height: 1.2;
        }
        .scope-chip.is-toggle { cursor: pointer; }
        .scope-chip.is-toggle:hover {
          color: var(--fg);
          border-color: var(--border-strong);
        }
      `}</style>
    </div>
  );
}

function ScopeChip({
  scope,
  options,
  onChange,
}: {
  scope: TrayScope;
  options?: TrayScope[];
  onChange?: (s: TrayScope) => void;
}) {
  const canToggle = !!options && options.length > 1 && !!onChange;
  const label = scope === "selection" ? "选区" : "全局";
  return (
    <span
      className={"scope-chip" + (canToggle ? " is-toggle" : "")}
      onClick={(e) => {
        if (!canToggle) return;
        e.stopPropagation();
        const idx = options!.indexOf(scope);
        const next = options![(idx + 1) % options!.length];
        onChange!(next);
      }}
    >
      {label}
    </span>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
