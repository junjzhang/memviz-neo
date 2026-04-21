use std::collections::HashMap;
use wasm_bindgen::prelude::*;

mod pickle;

use pickle::{Value as RcValue, ValueRc};

// ---- Data structures ----

#[derive(Clone, Hash, Eq, PartialEq)]
struct Frame { name: String, filename: String, line: i64 }

/// Frame + stack intern pools.
///
/// PyTorch memory traces carry hundreds of identical stack traces — in
/// iteration_2_exit one rank has 3.5M frame entries but only ~1400 unique
/// frames and maybe a few hundred unique stacks. Interning collapses the
/// per-event frame duplication down to one u32 per event, cutting both
/// JSON output size and the main thread's JS heap by 20-30×.
struct Pools {
    frame_pool: Vec<Frame>,
    frame_index: HashMap<Frame, u32>,
    stack_pool: Vec<Vec<u32>>,
    stack_index: HashMap<Vec<u32>, u32>,
}

impl Pools {
    fn new() -> Self {
        Self {
            frame_pool: Vec::new(),
            frame_index: HashMap::new(),
            stack_pool: Vec::new(),
            stack_index: HashMap::new(),
        }
    }
    fn intern_frame(&mut self, f: Frame) -> u32 {
        if let Some(&idx) = self.frame_index.get(&f) { return idx; }
        let idx = self.frame_pool.len() as u32;
        self.frame_index.insert(f.clone(), idx);
        self.frame_pool.push(f);
        idx
    }
    fn intern_stack(&mut self, frames: Vec<u32>) -> u32 {
        if let Some(&idx) = self.stack_index.get(&frames) { return idx; }
        let idx = self.stack_pool.len() as u32;
        self.stack_index.insert(frames.clone(), idx);
        self.stack_pool.push(frames);
        idx
    }
}

const NO_FRAME: u32 = u32::MAX;

struct Allocation {
    addr: i64,
    size: i64,
    alloc_us: i64,
    free_requested_us: i64,
    free_us: i64,
    top_frame_idx: u32,
    stack_idx: u32,
}

struct Segment {
    address: i64, total_size: i64, allocated_size: i64, active_size: i64,
    segment_type: String, blocks: Vec<Block>,
}

struct Block {
    address: i64,
    size: i64,
    state: String,
    top_frame_idx: u32,
}

// ---- Pickle walker ----
//
// Walks the Rc<Value> tree produced by pickle::parse. Values are shared
// via Rc so MEMOIZE/BINGET in the PyTorch snapshot pickle (which interns
// the frames list thousands of times) cost one Rc increment each, not a
// deep copy.

type DictCell = std::cell::RefCell<Vec<(ValueRc, ValueRc)>>;

fn rd_str(d: &DictCell, k: &str) -> String {
    pickle::dict_get(d, k).map(|v| pickle::to_str_rc(&v).to_string()).unwrap_or_default()
}
fn rd_int(d: &DictCell, k: &str) -> i64 {
    pickle::dict_get(d, k).map(|v| pickle::to_int(&v)).unwrap_or(0)
}

fn intern_frames(d: &DictCell, pools: &mut Pools) -> u32 {
    let mut indices: Vec<u32> = Vec::new();
    if let Some(frames_v) = pickle::dict_get(d, "frames") {
        pickle::with_list_items(&frames_v, |item| {
            if let Some(fd) = pickle::as_dict(item) {
                let frame = Frame {
                    name: rd_str(fd, "name"),
                    filename: rd_str(fd, "filename"),
                    line: rd_int(fd, "line"),
                };
                indices.push(pools.intern_frame(frame));
            }
        });
    }
    pools.intern_stack(indices)
}

/// Metadata from the root snapshot dict that isn't part of segments or
/// traces but is useful to display as header context (e.g. the allocator
/// config the snapshot was taken under).
#[derive(Default)]
struct RootMeta {
    /// PYTORCH_CUDA_ALLOC_CONF string, e.g. "expandable_segments:True".
    alloc_conf: String,
    /// Whether expandable_segments is on (from the parsed setting dict).
    expandable_segments: bool,
    /// max_split_size in MB (-1 = unlimited).
    max_split_size: i64,
    /// garbage_collection_threshold, 0..1.
    gc_threshold: f64,
}

fn parse_snapshot(
    data: &[u8],
    pools: &mut Pools,
) -> (Vec<Segment>, Vec<(String, i64, i64, i64, i64, u32)>, RootMeta) {
    let root = pickle::parse(data).expect("pickle parse failed");
    let root_dict = pickle::as_dict(&root).expect("root not a dict");

    // allocator_settings is a nested dict; drill in and pull the fields
    // the header actually surfaces.
    let mut meta = RootMeta::default();
    if let Some(sv) = pickle::dict_get(root_dict, "allocator_settings") {
        if let Some(sd) = pickle::as_dict(&sv) {
            meta.alloc_conf = rd_str(sd, "PYTORCH_CUDA_ALLOC_CONF");
            meta.max_split_size = rd_int(sd, "max_split_size");
            if let Some(v) = pickle::dict_get(sd, "expandable_segments") {
                meta.expandable_segments = matches!(v.as_ref(), RcValue::Bool(true));
            }
            if let Some(v) = pickle::dict_get(sd, "garbage_collection_threshold") {
                if let RcValue::Float(f) = v.as_ref() { meta.gc_threshold = *f; }
                else if let RcValue::Int(i) = v.as_ref() { meta.gc_threshold = *i as f64; }
            }
        }
    }

    let mut segments: Vec<Segment> = Vec::new();
    if let Some(segs_v) = pickle::dict_get(root_dict, "segments") {
        pickle::with_list_items(&segs_v, |sv| {
            let sd = match pickle::as_dict(sv) { Some(d) => d, None => return };
            let mut blocks: Vec<Block> = Vec::new();
            if let Some(bs_v) = pickle::dict_get(sd, "blocks") {
                pickle::with_list_items(&bs_v, |bv| {
                    let bd = match pickle::as_dict(bv) { Some(d) => d, None => return };
                    let stack_idx = intern_frames(bd, pools);
                    let top_frame_idx = resolve_top_frame_from_stack(stack_idx, pools);
                    blocks.push(Block {
                        address: rd_int(bd, "address"),
                        size: rd_int(bd, "size"),
                        state: rd_str(bd, "state"),
                        top_frame_idx,
                    });
                });
            }
            segments.push(Segment {
                address: rd_int(sd, "address"),
                total_size: rd_int(sd, "total_size"),
                allocated_size: rd_int(sd, "allocated_size"),
                active_size: rd_int(sd, "active_size"),
                segment_type: rd_str(sd, "segment_type"),
                blocks,
            });
        });
    }

    // device_traces — flatten, keep only events with "addr". Device index
    // disambiguates addresses across GPUs (shifted into the high bits of
    // the key used for alloc/free pairing).
    let mut traces: Vec<(String, i64, i64, i64, i64, u32)> = Vec::new();
    if let Some(dt_v) = pickle::dict_get(root_dict, "device_traces") {
        let outer_cell = match dt_v.as_ref() {
            RcValue::List(cell) => Some(cell),
            _ => None,
        };
        if let Some(outer_cell) = outer_cell {
            for (dev_idx_usize, dev) in outer_cell.borrow().iter().enumerate() {
                let dev_idx = dev_idx_usize as i64;
                let evs_cell = match pickle::as_list(dev) { Some(c) => c, None => continue };
                for ev in evs_cell.borrow().iter() {
                    let ed = match pickle::as_dict(ev) { Some(d) => d, None => continue };
                    if pickle::dict_get(ed, "addr").is_none() { continue; }
                    let addr = rd_int(ed, "addr");
                    let device_addr = (dev_idx << 48) | (addr & 0x0000_FFFF_FFFF_FFFF);
                    let stack_idx = intern_frames(ed, pools);
                    traces.push((
                        rd_str(ed, "action"),
                        device_addr,
                        rd_int(ed, "size"),
                        rd_int(ed, "time_us"),
                        addr,
                        stack_idx,
                    ));
                }
            }
        }
    }
    traces.sort_by_key(|t| t.3);

    (segments, traces, meta)
}

// ---- Top frame selection ----

fn is_internal(f: &Frame) -> bool {
    f.filename == "??"
        || f.name.contains("CUDACachingAllocator")
        || f.filename.contains("memory_snapshot")
}

/// Pick the "most meaningful" frame index from a stack:
///   first python (.py) frame that isn't a CUDA allocator internal,
///   else the first non-internal frame,
///   else NO_FRAME.
fn resolve_top_frame_from_stack(stack_idx: u32, pools: &Pools) -> u32 {
    let stack = &pools.stack_pool[stack_idx as usize];
    for &fidx in stack {
        let f = &pools.frame_pool[fidx as usize];
        if is_internal(f) { continue; }
        if f.filename.contains(".py") { return fidx; }
    }
    for &fidx in stack {
        let f = &pools.frame_pool[fidx as usize];
        if is_internal(f) { continue; }
        return fidx;
    }
    NO_FRAME
}

// ---- Alloc/free pairing ----
//
// PyTorch's `device_traces` is a ring buffer of the last ~50k events.
// When training outlives the buffer, the window starts mid-run: some
// frees reference allocations made before the window ("orphan frees"),
// and some allocations persisted from before the window are still live
// at snapshot time. Both groups form a baseline that must be modeled,
// otherwise the timeline shape matches neither the true memory usage
// nor PyTorch's own _memory_viz output.
//
// Reconstruction:
//   L_end   = sum of active_allocated blocks in segments at snapshot
//   running = sum(alloc sizes) - sum(all free sizes) observed in window
//   L_start = L_end - running        (bytes alive when window began)
//   peak    = L_start + max(running) (true peak over the window)
//
// Orphan frees are synthesized as allocations with alloc_us = t_min so
// they appear in the timeline as rectangles that shrink as they get
// freed. What remains of L_start (pre-window allocs that never freed in
// the window) we emit as `baseline_invisible` — an aggregate y-offset
// the renderer draws as a band so the y axis matches reality.

fn build_allocations(
    traces: &[(String, i64, i64, i64, i64, u32)],
    segments_active_allocated: i64,
    pools: &Pools,
) -> (Vec<Allocation>, i64, i64, i64, i64) {
    if traces.is_empty() { return (vec![], 0, 0, 0, 0); }
    struct P { raw_addr: i64, size: i64, time_us: i64, free_req: i64, stack_idx: u32 }
    let mut pending: HashMap<i64, P> = HashMap::new();
    let mut allocs = Vec::new();

    // Net delta from window start. Goes negative if pre-window allocs
    // get freed faster than in-window allocs happen. max_running is the
    // largest excursion above the starting baseline.
    let mut running: i64 = 0;
    let mut max_running: i64 = 0;

    // (raw_addr, size, free_us, stack_idx) for orphan frees we'll later
    // materialize as pre-window allocations.
    let mut orphans: Vec<(i64, i64, i64, u32)> = Vec::new();

    let t_min = traces.first().unwrap().3;
    let t_max = traces.last().unwrap().3;

    for (action, device_addr, size, time_us, raw_addr, stack_idx) in traces {
        match action.as_str() {
            "alloc" => {
                pending.insert(*device_addr, P {
                    raw_addr: *raw_addr, size: *size, time_us: *time_us,
                    free_req: -1, stack_idx: *stack_idx,
                });
                running += size;
                if running > max_running { max_running = running; }
            }
            "free_requested" => { if let Some(p) = pending.get_mut(device_addr) { p.free_req = *time_us; } }
            "free_completed" => {
                if let Some(p) = pending.remove(device_addr) {
                    let top = resolve_top_frame_from_stack(p.stack_idx, pools);
                    allocs.push(Allocation {
                        addr: p.raw_addr, size: p.size, alloc_us: p.time_us,
                        free_requested_us: p.free_req, free_us: *time_us,
                        top_frame_idx: top, stack_idx: p.stack_idx,
                    });
                    running -= p.size;
                } else {
                    orphans.push((*raw_addr, *size, *time_us, *stack_idx));
                    running -= size;
                }
            }
            _ => {}
        }
    }

    let orphan_total: i64 = orphans.iter().map(|o| o.1).sum();
    for (raw_addr, size, free_us, stack_idx) in orphans {
        let top = resolve_top_frame_from_stack(stack_idx, pools);
        allocs.push(Allocation {
            addr: raw_addr, size, alloc_us: t_min, free_requested_us: -1,
            free_us, top_frame_idx: top, stack_idx,
        });
    }

    for (_key, p) in pending.drain() {
        let top = resolve_top_frame_from_stack(p.stack_idx, pools);
        allocs.push(Allocation {
            addr: p.raw_addr, size: p.size, alloc_us: p.time_us, free_requested_us: p.free_req,
            free_us: -1, top_frame_idx: top, stack_idx: p.stack_idx,
        });
    }

    let baseline_total = (segments_active_allocated - running).max(0);
    // What the orphan rectangles can't represent — persistent pre-window
    // allocations still alive at snapshot. Drawn as an aggregate band.
    let baseline_invisible = (baseline_total - orphan_total).max(0);
    let peak = baseline_total + max_running;

    (allocs, t_min, t_max, peak, baseline_invisible)
}

// ---- JSON output helpers ----

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"), '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => { let _ = std::fmt::Write::write_fmt(&mut o, format_args!("\\u{:04x}", c as u32)); }
            c => o.push(c),
        }
    }
    o.push('"'); o
}

fn emit_frame_idx(buf: &mut String, idx: u32) {
    if idx == NO_FRAME { buf.push_str("-1"); } else { let _ = std::fmt::Write::write_fmt(buf, format_args!("{}", idx as i64)); }
}

// ---- WASM entry ----

/// Bench-only: decode pickle bytes into the Rc<Value> tree and return the
/// node count, nothing else. Direct analogue of pytorch's `unpickle` —
/// no interning, no pairing, no IR emit. Used to compare pickle-decode
/// cost apples-to-apples.
#[wasm_bindgen]
pub fn parse_pickle_only(data: &[u8]) -> u32 {
    let root = pickle::parse(data).expect("pickle parse failed");
    // Force a shallow touch so the optimizer can't DCE the whole parse.
    match root.as_ref() {
        RcValue::Dict(cell) => cell.borrow().len() as u32,
        RcValue::List(cell) => cell.borrow().len() as u32,
        _ => 0,
    }
}

/// Parse pickle, intern frames/stacks, pair alloc/free events, and emit
/// an Intermediate Representation (IR) JSON that the main thread hands
/// off to layout workers. Polygon layout runs in pure JS on the layout
/// worker so the N-layout-worker WASM footprint is zero (JS heap is GC'd,
/// unlike WASM linear memory which is grow-only).
#[wasm_bindgen]
pub fn parse_intern(data: &[u8], rank: i32, layout_limit: i32) -> String {
    let mut pools = Pools::new();
    let (segments, traces, meta) = parse_snapshot(data, &mut pools);

    let seg_active: i64 = segments.iter()
        .flat_map(|s| s.blocks.iter())
        .filter(|b| b.state == "active_allocated")
        .map(|b| b.size)
        .sum();

    let (allocs, t_min, t_max, peak, baseline) =
        build_allocations(&traces, seg_active, &pools);

    // Pick top-N by size. Tie-break on alloc_us then addr to keep output
    // deterministic when multiple allocations share a size.
    // layout_limit <= 0 means keep all.
    let mut top_idx: Vec<usize> = (0..allocs.len()).collect();
    top_idx.sort_by(|&a, &b| {
        allocs[b].size.cmp(&allocs[a].size)
            .then_with(|| allocs[a].alloc_us.cmp(&allocs[b].alloc_us))
            .then_with(|| allocs[a].addr.cmp(&allocs[b].addr))
    });
    if layout_limit > 0 {
        top_idx.truncate(layout_limit as usize);
    }

    let mut j = String::with_capacity(2 * 1024 * 1024);
    j.push('{');

    // Summary
    let (mut tr, mut ta, mut tac, mut sc, mut bc, mut ab, mut ib) = (0i64,0,0,0usize,0usize,0i64,0i64);
    for s in &segments {
        tr += s.total_size; ta += s.allocated_size; tac += s.active_size; sc += 1;
        for b in &s.blocks { bc += 1; if b.state == "active_allocated" { ab += b.size; } else if b.state == "inactive" { ib += b.size; } }
    }
    j.push_str(&format!(
        "\"summary\":{{\"rank\":{rank},\"total_reserved\":{tr},\"total_allocated\":{ta},\"total_active\":{tac},\"segment_count\":{sc},\"block_count\":{bc},\"active_bytes\":{ab},\"inactive_bytes\":{ib},\"baseline\":{baseline},\"peak_bytes\":{peak},\"alloc_conf\":{},\"expandable_segments\":{},\"max_split_size\":{},\"gc_threshold\":{}}},",
        json_str(&meta.alloc_conf),
        meta.expandable_segments,
        meta.max_split_size,
        meta.gc_threshold,
    ));
    j.push_str(&format!("\"timeline\":{{\"time_min\":{t_min},\"time_max\":{t_max},\"peak_bytes\":{peak},\"baseline\":{baseline},\"allocation_count\":{}}},", allocs.len()));

    // Interned frame pool: [[name, filename, line], ...]
    j.push_str("\"frame_pool\":[");
    for (i, f) in pools.frame_pool.iter().enumerate() {
        if i > 0 { j.push(','); }
        j.push_str(&format!("[{},{},{}]", json_str(&f.name), json_str(&f.filename), f.line));
    }
    j.push_str("],");

    // Interned stack pool: [[frame_idx, ...], ...]
    j.push_str("\"stack_pool\":[");
    for (i, stk) in pools.stack_pool.iter().enumerate() {
        if i > 0 { j.push(','); }
        j.push('[');
        for (k, &fidx) in stk.iter().enumerate() {
            if k > 0 { j.push(','); }
            let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", fidx));
        }
        j.push(']');
    }
    j.push_str("],");

    // Segments for treemap / address map.
    j.push_str("\"segments\":[");
    for (si, s) in segments.iter().enumerate() {
        if si > 0 { j.push(','); }
        j.push_str(&format!("{{\"address\":{},\"total_size\":{},\"allocated_size\":{},\"segment_type\":{},\"blocks\":[",
            s.address, s.total_size, s.allocated_size, json_str(&s.segment_type)));
        for (bi, b) in s.blocks.iter().enumerate() {
            if bi > 0 { j.push(','); }
            j.push_str(&format!("{{\"address\":{},\"size\":{},\"state\":{},\"offset_in_segment\":{},\"top_frame_idx\":",
                b.address, b.size, json_str(&b.state), b.address - s.address));
            emit_frame_idx(&mut j, b.top_frame_idx);
            j.push('}');
        }
        j.push_str("]}");
    }
    j.push_str("],");

    // Top-N allocations: layout-worker input. Each entry carries the
    // minimum scalars needed for polygon layout, strip packing, anomaly
    // detection, and detail panel resolution (via stack_idx -> stack_pool).
    j.push_str("\"top_allocations\":[");
    for (i, &ai) in top_idx.iter().enumerate() {
        let a = &allocs[ai];
        if i > 0 { j.push(','); }
        j.push_str(&format!("{{\"idx\":{},\"addr\":{},\"size\":{},\"alloc_us\":{},\"free_requested_us\":{},\"free_us\":{},\"top_frame_idx\":",
            i, a.addr, a.size, a.alloc_us, a.free_requested_us, a.free_us));
        emit_frame_idx(&mut j, a.top_frame_idx);
        j.push_str(",\"stack_idx\":");
        let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", a.stack_idx));
        j.push('}');
    }
    j.push_str("]");

    j.push('}'); j
}
