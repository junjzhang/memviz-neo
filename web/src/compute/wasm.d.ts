declare module "../../../wasm/pkg/memviz_wasm.js" {
  export default function init(options?: { module: WebAssembly.Module }): void;
  export function initSync(options: { module: WebAssembly.Module }): void;
  export function process_snapshot(data: Uint8Array, rank: number, layout_limit: number): string;
}

declare module "../../../wasm/pkg/memviz_wasm_bg.wasm?url" {
  const url: string;
  export default url;
}
