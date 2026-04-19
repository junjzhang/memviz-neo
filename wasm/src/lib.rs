use std::collections::{BTreeMap, HashMap};
use wasm_bindgen::prelude::*;
use serde_pickle::value::HashableValue;
use serde_pickle::Value;

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

// ---- Pickle value helpers ----

type Dict = BTreeMap<HashableValue, Value>;

fn dict_get<'a>(d: &'a Dict, key: &str) -> Option<&'a Value> {
    d.get(&HashableValue::String(key.to_string()))
}

fn val_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        _ => String::new(),
    }
}

fn val_int(v: &Value) -> i64 {
    match v {
        Value::I64(n) => *n,
        Value::F64(n) => *n as i64,
        Value::Bool(b) => if *b { 1 } else { 0 },
        _ => 0,
    }
}

fn dstr(d: &Dict, k: &str) -> String { dict_get(d, k).map(val_str).unwrap_or_default() }
fn dint(d: &Dict, k: &str) -> i64 { dict_get(d, k).map(val_int).unwrap_or(0) }

fn dlist<'a>(d: &'a Dict, k: &str) -> &'a [Value] {
    match dict_get(d, k) {
        Some(Value::List(l)) => l, Some(Value::Tuple(l)) => l, _ => &[],
    }
}

fn as_dict(v: &Value) -> Option<&Dict> {
    match v { Value::Dict(d) => Some(d), _ => None }
}

/// Parse the "frames" list of a dict into interned frame indices, then
/// return a single stack index into the stack pool.
fn intern_frames(d: &Dict, pools: &mut Pools) -> u32 {
    let indices: Vec<u32> = dlist(d, "frames").iter().filter_map(|v| {
        let fd = as_dict(v)?;
        let frame = Frame {
            name: dstr(fd, "name"),
            filename: dstr(fd, "filename"),
            line: dint(fd, "line"),
        };
        Some(pools.intern_frame(frame))
    }).collect();
    pools.intern_stack(indices)
}

// ---- Pickle parsing ----

fn parse_snapshot(
    data: &[u8],
    pools: &mut Pools,
) -> (Vec<Segment>, Vec<(String, i64, i64, i64, i64, u32)>) {
    let opts = serde_pickle::DeOptions::new().replace_recursive_structures();
    let val: Value = serde_pickle::from_slice(data, opts).expect("pickle parse failed");
    let root = as_dict(&val).expect("root not dict");

    let segments: Vec<Segment> = dlist(root, "segments").iter().filter_map(|sv| {
        let sd = as_dict(sv)?;
        let blocks = dlist(sd, "blocks").iter().filter_map(|bv| {
            let bd = as_dict(bv)?;
            let stack_idx = intern_frames(bd, pools);
            let top_frame_idx = resolve_top_frame_from_stack(stack_idx, pools);
            Some(Block {
                address: dint(bd, "address"),
                size: dint(bd, "size"),
                state: dstr(bd, "state"),
                top_frame_idx,
            })
        }).collect();
        Some(Segment {
            address: dint(sd, "address"), total_size: dint(sd, "total_size"),
            allocated_size: dint(sd, "allocated_size"), active_size: dint(sd, "active_size"),
            segment_type: dstr(sd, "segment_type"), blocks,
        })
    }).collect();

    // Flatten device_traces — device index used to disambiguate addresses across GPUs
    let mut traces: Vec<(String, i64, i64, i64, i64, u32)> = Vec::new(); // (action, device_addr_key, size, time_us, raw_addr, stack_idx)
    for (dev_idx, dt) in dlist(root, "device_traces").iter().enumerate() {
        let evs = match dt { Value::List(l) => l.as_slice(), Value::Tuple(l) => l.as_slice(), _ => continue };
        for ev in evs {
            let ed = match as_dict(ev) { Some(d) => d, None => continue };
            if dict_get(ed, "addr").is_none() { continue; }
            let addr = dint(ed, "addr");
            let device_addr = (dev_idx as i64) << 48 | (addr & 0x0000_FFFF_FFFF_FFFF);
            let stack_idx = intern_frames(ed, pools);
            traces.push((dstr(ed, "action"), device_addr, dint(ed, "size"), dint(ed, "time_us"), addr, stack_idx));
        }
    }
    traces.sort_by_key(|t| t.3);

    (segments, traces)
}

// ---- Top frame selection ----

/// Pick the "most meaningful" frame index from a stack:
///   first python (.py) frame that isn't a CUDA allocator internal,
///   else the first non-internal frame,
///   else NO_FRAME.
fn resolve_top_frame_from_stack(stack_idx: u32, pools: &Pools) -> u32 {
    let stack = &pools.stack_pool[stack_idx as usize];
    // first .py
    for &fidx in stack {
        let f = &pools.frame_pool[fidx as usize];
        if f.filename == "??" || f.name.contains("CUDACachingAllocator") || f.filename.contains("memory_snapshot") {
            continue;
        }
        if f.filename.contains(".py") {
            return fidx;
        }
    }
    // fallback: first non-internal
    for &fidx in stack {
        let f = &pools.frame_pool[fidx as usize];
        if f.filename == "??" || f.name.contains("CUDACachingAllocator") || f.filename.contains("memory_snapshot") {
            continue;
        }
        return fidx;
    }
    NO_FRAME
}

// ---- Alloc/free pairing ----

fn build_allocations(
    traces: &[(String, i64, i64, i64, i64, u32)],
    pools: &Pools,
) -> (Vec<Allocation>, i64, i64, i64) {
    if traces.is_empty() { return (vec![], 0, 0, 0); }
    struct P { raw_addr: i64, size: i64, time_us: i64, free_req: i64, stack_idx: u32 }
    let mut pending: HashMap<i64, P> = HashMap::new();
    let mut allocs = Vec::new();
    let mut total: i64 = 0;
    let mut peak: i64 = 0;

    for (action, device_addr, size, time_us, raw_addr, stack_idx) in traces {
        match action.as_str() {
            "alloc" => {
                pending.insert(*device_addr, P {
                    raw_addr: *raw_addr, size: *size, time_us: *time_us,
                    free_req: -1, stack_idx: *stack_idx,
                });
                total += size; if total > peak { peak = total; }
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
                    total -= p.size;
                }
            }
            _ => {}
        }
    }
    let t_min = traces.first().unwrap().3;
    let t_max = traces.last().unwrap().3;
    for (_key, p) in pending.drain() {
        let top = resolve_top_frame_from_stack(p.stack_idx, pools);
        allocs.push(Allocation {
            addr: p.raw_addr, size: p.size, alloc_us: p.time_us, free_requested_us: p.free_req,
            free_us: -1, top_frame_idx: top, stack_idx: p.stack_idx,
        });
    }
    (allocs, t_min, t_max, peak)
}

// ---- Polygon layout ----

fn build_layout(allocs: &[Allocation], t_max: i64, limit: usize) -> (Vec<usize>, Vec<[i64; 4]>) {
    let mut idx: Vec<usize> = (0..allocs.len()).collect();
    idx.sort_by(|&a, &b| allocs[b].size.cmp(&allocs[a].size));
    idx.truncate(limit);
    let n = idx.len();
    if n == 0 { return (idx, vec![]); }

    let mut events: Vec<(i64, u8, usize, i64)> = Vec::with_capacity(n * 2);
    for (li, &ai) in idx.iter().enumerate() {
        let a = &allocs[ai];
        events.push((a.alloc_us, 1, li, a.size));
        if a.free_us != -1 { events.push((a.free_us, 0, li, a.size)); }
    }
    events.sort();

    let mut sk_id: Vec<usize> = Vec::with_capacity(n);
    let mut sk_sz: Vec<i64> = Vec::with_capacity(n);
    let mut pos = vec![usize::MAX; n];
    let mut t_st = vec![0i64; n];
    let mut y = vec![0i64; n];
    let mut act = vec![false; n];
    let mut stot: i64 = 0;
    let mut out: Vec<[i64; 4]> = Vec::new();

    for &(time, et, li, sz) in &events {
        if et == 1 {
            y[li] = stot; t_st[li] = time; pos[li] = sk_id.len();
            sk_id.push(li); sk_sz.push(sz); act[li] = true; stot += sz;
        } else {
            let p = pos[li]; if p == usize::MAX { continue; }
            if t_st[li] < time { out.push([li as i64, t_st[li], time, y[li]]); }
            act[li] = false; pos[li] = usize::MAX;
            let freed = sk_sz[p];
            sk_id.remove(p); sk_sz.remove(p); stot -= freed;
            for i in p..sk_id.len() {
                let ai = sk_id[i]; pos[ai] = i;
                let oy = y[ai];
                if t_st[ai] < time { out.push([ai as i64, t_st[ai], time, oy]); }
                t_st[ai] = time; y[ai] = oy - freed;
            }
        }
    }
    for li in 0..n {
        if act[li] && t_st[li] < t_max { out.push([li as i64, t_st[li], t_max, y[li]]); }
    }
    (idx, out)
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

#[wasm_bindgen]
pub fn process_snapshot(data: &[u8], rank: i32, layout_limit: i32) -> String {
    let mut pools = Pools::new();
    let (segments, traces) = parse_snapshot(data, &mut pools);
    let (allocs, t_min, t_max, peak) = build_allocations(&traces, &pools);
    let (top_idx, strips) = build_layout(&allocs, t_max, layout_limit as usize);
    let n = top_idx.len();

    let mut j = String::with_capacity(2 * 1024 * 1024);
    j.push('{');

    // Summary
    let (mut tr, mut ta, mut tac, mut sc, mut bc, mut ab, mut ib) = (0i64,0,0,0usize,0usize,0i64,0i64);
    for s in &segments {
        tr += s.total_size; ta += s.allocated_size; tac += s.active_size; sc += 1;
        for b in &s.blocks { bc += 1; if b.state == "active_allocated" { ab += b.size; } else if b.state == "inactive" { ib += b.size; } }
    }
    j.push_str(&format!("\"summary\":{{\"rank\":{rank},\"total_reserved\":{tr},\"total_allocated\":{ta},\"total_active\":{tac},\"segment_count\":{sc},\"block_count\":{bc},\"active_bytes\":{ab},\"inactive_bytes\":{ib}}},"));
    j.push_str(&format!("\"timeline\":{{\"time_min\":{t_min},\"time_max\":{t_max},\"peak_bytes\":{peak},\"allocation_count\":{}}},", allocs.len()));

    // ---- Interned frame pool ----
    // Shape: frame_pool = [[name, filename, line], ...]
    j.push_str("\"frame_pool\":[");
    for (i, f) in pools.frame_pool.iter().enumerate() {
        if i > 0 { j.push(','); }
        j.push_str(&format!("[{},{},{}]", json_str(&f.name), json_str(&f.filename), f.line));
    }
    j.push_str("],");

    // ---- Interned stack pool ----
    // Shape: stack_pool = [[frame_idx, frame_idx, ...], ...]
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

    // Blocks with strips. top_frame_idx replaces the inline top_frame string.
    j.push_str("\"blocks\":[");
    let mut strips_per: Vec<Vec<&[i64; 4]>> = vec![vec![]; n];
    for s in &strips { strips_per[s[0] as usize].push(s); }

    for i in 0..n {
        let a = &allocs[top_idx[i]];
        if i > 0 { j.push(','); }
        let free_us = if a.free_us == -1 { t_max } else { a.free_us };
        let alive = a.free_us == -1;
        j.push_str("{\"addr\":"); let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", a.addr));
        j.push_str(",\"size\":"); let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", a.size));
        j.push_str(",\"alloc_us\":"); let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", a.alloc_us));
        j.push_str(",\"free_requested_us\":"); let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", a.free_requested_us));
        j.push_str(",\"free_us\":"); let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", free_us));
        j.push_str(",\"alive\":"); j.push_str(if alive { "true" } else { "false" });
        j.push_str(",\"top_frame_idx\":"); emit_frame_idx(&mut j, a.top_frame_idx);
        j.push_str(",\"idx\":"); let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", i));
        j.push_str(",\"strips\":[");
        for (si, s) in strips_per[i].iter().enumerate() {
            if si > 0 { j.push(','); }
            j.push_str(&format!("{{\"t_start\":{},\"t_end\":{},\"y_offset\":{}}}", s[1], s[2], s[3]));
        }
        j.push_str("]}");
    }
    j.push_str("],");

    // Segments for treemap / address map. top_frame_idx replaces the
    // inline top_frame string per block.
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

    // Alloc details — only the top_idx allocations. Each carries just
    // scalars + stack_idx now; frames resolve via pool lookup on the JS
    // side (getDetail) instead of inlining 70 frame dicts per entry.
    j.push_str("\"alloc_details\":[");
    for (i, &ai) in top_idx.iter().enumerate() {
        let a = &allocs[ai];
        if i > 0 { j.push(','); }
        j.push_str(&format!("{{\"addr\":{},\"size\":{},\"alloc_us\":{},\"free_requested_us\":{},\"free_us\":{},\"top_frame_idx\":",
            a.addr, a.size, a.alloc_us, a.free_requested_us, a.free_us));
        emit_frame_idx(&mut j, a.top_frame_idx);
        j.push_str(",\"stack_idx\":");
        let _ = std::fmt::Write::write_fmt(&mut j, format_args!("{}", a.stack_idx));
        j.push('}');
    }
    j.push_str("]");

    j.push('}'); j
}
