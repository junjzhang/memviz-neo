use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

mod pickle;
use pickle::{parse as pickle_parse, as_dict, dict_get, to_int, to_str_rc, with_list_items, ValueRc, Value};

// ---- Intern pools ----

#[derive(Clone, Hash, Eq, PartialEq)]
struct FrameKey { name: Rc<str>, filename: Rc<str>, line: i64 }

/// Frame + stack intern pools.
///
/// PyTorch memory traces carry hundreds of identical stack traces. Interning
/// collapses the per-event frame duplication down to one u32 per event, cutting
/// both JSON output size and the main thread's JS heap by 20-30×.
struct Pools {
    frame_pool: Vec<FrameKey>,
    frame_index: HashMap<FrameKey, u32>,
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
    fn intern_frame(&mut self, f: FrameKey) -> u32 {
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
    segment_type: Rc<str>, blocks: Vec<Block>,
}

struct Block {
    address: i64,
    size: i64,
    state: Rc<str>,
    top_frame_idx: u32,
}

// ---- Walk: consume the Rc<Value> tree into our own structs, interning ----

fn intern_frames_from(dict_v: &ValueRc, pools: &mut Pools) -> u32 {
    let mut indices: Vec<u32> = Vec::new();
    let d = match as_dict(dict_v) { Some(d) => d, None => return pools.intern_stack(indices) };
    let frames = match dict_get(d, "frames") { Some(f) => f, None => return pools.intern_stack(indices) };
    with_list_items(&frames, |frame_v| {
        if let Some(fd) = as_dict(frame_v) {
            let name_v = dict_get(fd, "name");
            let file_v = dict_get(fd, "filename");
            let line_v = dict_get(fd, "line");
            let key = FrameKey {
                name: name_v.as_ref().map(to_str_rc).unwrap_or_else(|| Rc::from("")),
                filename: file_v.as_ref().map(to_str_rc).unwrap_or_else(|| Rc::from("")),
                line: line_v.as_ref().map(to_int).unwrap_or(0),
            };
            indices.push(pools.intern_frame(key));
        }
    });
    pools.intern_stack(indices)
}

fn resolve_top_frame_from_stack(stack_idx: u32, pools: &Pools) -> u32 {
    let stack = &pools.stack_pool[stack_idx as usize];
    for &fidx in stack {
        let f = &pools.frame_pool[fidx as usize];
        if f.filename.as_ref() == "??"
            || f.name.contains("CUDACachingAllocator")
            || f.filename.contains("memory_snapshot") { continue; }
        if f.filename.contains(".py") { return fidx; }
    }
    for &fidx in stack {
        let f = &pools.frame_pool[fidx as usize];
        if f.filename.as_ref() == "??"
            || f.name.contains("CUDACachingAllocator")
            || f.filename.contains("memory_snapshot") { continue; }
        return fidx;
    }
    NO_FRAME
}

fn parse_snapshot(
    data: &[u8],
    pools: &mut Pools,
) -> (Vec<Segment>, Vec<(Rc<str>, i64, i64, i64, i64, u32)>) {
    let root = pickle_parse(data).expect("pickle parse failed");
    let root_d = match as_dict(&root) {
        Some(d) => d,
        None => return (Vec::new(), Vec::new()),
    };

    // ---- Segments ----
    let mut segments: Vec<Segment> = Vec::new();
    if let Some(seg_list) = dict_get(root_d, "segments") {
        with_list_items(&seg_list, |sv| {
            let sd = match as_dict(sv) { Some(d) => d, None => return };
            let mut blocks: Vec<Block> = Vec::new();
            if let Some(bl) = dict_get(sd, "blocks") {
                with_list_items(&bl, |bv| {
                    let bd = match as_dict(bv) { Some(d) => d, None => return };
                    let stack_idx = intern_frames_from(bv, pools);
                    let top = resolve_top_frame_from_stack(stack_idx, pools);
                    blocks.push(Block {
                        address: dict_get(bd, "address").as_ref().map(to_int).unwrap_or(0),
                        size: dict_get(bd, "size").as_ref().map(to_int).unwrap_or(0),
                        state: dict_get(bd, "state").as_ref().map(to_str_rc).unwrap_or_else(|| Rc::from("")),
                        top_frame_idx: top,
                    });
                });
            }
            segments.push(Segment {
                address: dict_get(sd, "address").as_ref().map(to_int).unwrap_or(0),
                total_size: dict_get(sd, "total_size").as_ref().map(to_int).unwrap_or(0),
                allocated_size: dict_get(sd, "allocated_size").as_ref().map(to_int).unwrap_or(0),
                active_size: dict_get(sd, "active_size").as_ref().map(to_int).unwrap_or(0),
                segment_type: dict_get(sd, "segment_type").as_ref().map(to_str_rc).unwrap_or_else(|| Rc::from("")),
                blocks,
            });
        });
    }

    // ---- Traces ----
    let mut traces: Vec<(Rc<str>, i64, i64, i64, i64, u32)> = Vec::new();
    if let Some(dev_list) = dict_get(root_d, "device_traces") {
        let mut dev_idx: i64 = 0;
        with_list_items(&dev_list, |dv| {
            with_list_items(dv, |ev| {
                let ed = match as_dict(ev) { Some(d) => d, None => return };
                let addr_v = match dict_get(ed, "addr") { Some(v) => v, None => return };
                let addr = to_int(&addr_v);
                let device_addr = (dev_idx << 48) | (addr & 0x0000_FFFF_FFFF_FFFF);
                let stack_idx = intern_frames_from(ev, pools);
                let action = dict_get(ed, "action").as_ref().map(to_str_rc).unwrap_or_else(|| Rc::from(""));
                let size = dict_get(ed, "size").as_ref().map(to_int).unwrap_or(0);
                let time_us = dict_get(ed, "time_us").as_ref().map(to_int).unwrap_or(0);
                traces.push((action, device_addr, size, time_us, addr, stack_idx));
            });
            dev_idx += 1;
        });
    }
    traces.sort_by_key(|t| t.3);

    // root Value tree drops here (the binding goes out of scope); memo
    // table and all Rc<Value> get released. Only segments + traces (light
    // structs) remain in WASM memory.
    (segments, traces)
}

// ---- Alloc/free pairing ----

fn build_allocations(
    traces: &[(Rc<str>, i64, i64, i64, i64, u32)],
    pools: &Pools,
) -> (Vec<Allocation>, i64, i64, i64) {
    if traces.is_empty() { return (vec![], 0, 0, 0); }
    struct P { raw_addr: i64, size: i64, time_us: i64, free_req: i64, stack_idx: u32 }
    let mut pending: HashMap<i64, P> = HashMap::new();
    let mut allocs = Vec::new();
    let mut total: i64 = 0;
    let mut peak: i64 = 0;

    for (action, device_addr, size, time_us, raw_addr, stack_idx) in traces {
        match action.as_ref() {
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

// silence unused warnings for types we carry through pickle::
#[allow(dead_code)]
fn _phantom(_: &Value) {}

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
        for b in &s.blocks { bc += 1; if b.state.as_ref() == "active_allocated" { ab += b.size; } else if b.state.as_ref() == "inactive" { ib += b.size; } }
    }
    j.push_str(&format!("\"summary\":{{\"rank\":{rank},\"total_reserved\":{tr},\"total_allocated\":{ta},\"total_active\":{tac},\"segment_count\":{sc},\"block_count\":{bc},\"active_bytes\":{ab},\"inactive_bytes\":{ib}}},"));
    j.push_str(&format!("\"timeline\":{{\"time_min\":{t_min},\"time_max\":{t_max},\"peak_bytes\":{peak},\"allocation_count\":{}}},", allocs.len()));

    // Interned frame pool
    j.push_str("\"frame_pool\":[");
    for (i, f) in pools.frame_pool.iter().enumerate() {
        if i > 0 { j.push(','); }
        j.push_str(&format!("[{},{},{}]", json_str(&f.name), json_str(&f.filename), f.line));
    }
    j.push_str("],");

    // Interned stack pool
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

    // Blocks with strips
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

    // Segments
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

    // Alloc details — top_idx only
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
