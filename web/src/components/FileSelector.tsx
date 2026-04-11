import { useRef } from "react";
import { Progress } from "antd";
import { useFileStore } from "../stores/fileStore";

const hasDirectoryPicker = typeof window !== "undefined" && "showDirectoryPicker" in window;

export default function FileSelector() {
  const { status, progress, error, fileNames, openDirectory, openFiles } = useFileStore();
  const inputRef = useRef<HTMLInputElement>(null);

  if (status === "loading") {
    return (
      <div style={{ maxWidth: 480, margin: "120px auto", textAlign: "center" }}>
        <h2 style={{ color: "#ccc", marginBottom: 24 }}>Loading snapshots...</h2>
        <Progress
          percent={Math.round(progress * 100)}
          status="active"
          strokeColor="#3b82f6"
        />
        <div style={{ color: "#666", marginTop: 12, fontSize: 13, fontFamily: "monospace" }}>
          {fileNames[Math.min(Math.floor(progress * fileNames.length), fileNames.length - 1)]}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "120px auto", textAlign: "center" }}>
      <h1 style={{ color: "#eee", fontSize: 28, marginBottom: 8 }}>memviz-neo</h1>
      <p style={{ color: "#888", marginBottom: 32 }}>PyTorch GPU Memory Visualization</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        {hasDirectoryPicker && (
          <button
            onClick={openDirectory}
            style={{
              padding: "12px 32px",
              fontSize: 16,
              background: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              width: 280,
            }}
          >
            Open Snapshot Directory
          </button>
        )}

        <button
          onClick={() => inputRef.current?.click()}
          style={{
            padding: "10px 24px",
            fontSize: 14,
            background: hasDirectoryPicker ? "transparent" : "#3b82f6",
            color: hasDirectoryPicker ? "#888" : "#fff",
            border: hasDirectoryPicker ? "1px solid #444" : "none",
            borderRadius: 6,
            cursor: "pointer",
            width: 280,
          }}
        >
          {hasDirectoryPicker ? "Or select .pickle files" : "Select .pickle files"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pickle"
          style={{ display: "none" }}
          onChange={(e) => e.target.files && openFiles(e.target.files)}
        />
      </div>

      {error && (
        <div style={{ color: "#ef4444", marginTop: 20, fontSize: 13 }}>{error}</div>
      )}

      <p style={{ color: "#555", marginTop: 40, fontSize: 12 }}>
        Files are parsed locally in your browser. Nothing is uploaded.
      </p>
    </div>
  );
}
