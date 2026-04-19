import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";

// Dev-only long-task profiler. Captures any main-thread task ≥50ms so I
// can diagnose navigation jank during large loads (iteration_5 = 128
// ranks). Exposed on window for the Chrome extension to read.
if (import.meta.env.DEV && typeof window !== "undefined" && typeof PerformanceObserver !== "undefined") {
  interface LongTaskEntry { ts: number; durMs: number; name: string; }
  const tasks: LongTaskEntry[] = [];
  const t0 = performance.now();
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        tasks.push({
          ts: Math.round(e.startTime - t0),
          durMs: Math.round(e.duration),
          name: e.name,
        });
      }
    });
    obs.observe({ type: "longtask", buffered: true });
    (window as any).__memvizLongTasks = tasks;
    (window as any).__memvizClearLongTasks = () => { tasks.length = 0; };
  } catch { /* longtask API not supported */ }
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
