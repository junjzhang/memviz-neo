use std::collections::{BTreeMap, HashMap};
use wasm_bindgen::prelude::*;
use serde_pickle::value::HashableValue;
use serde_pickle::Value;

// ---- Data structures ----

#[derive(Clone)]
struct Frame { name: String, filename: String, line: i64 }

struct Allocation {
    addr: i64, size: i64, alloc_us: i64, free_requested_us: i64, free_us: i64,
    top_frame: String, frames: Vec<Frame>,
}

struct Segment {
    address: i64, total_size: i64, allocated_size: i64, active_size: i64,
    segment_type: String, blocks: Vec<Block>,
}

struct Block { address: i64, size: i64, state: String, frames: Vec<Frame> }

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

fn parse_frames(d: &Dict) -> Vec<Frame> {
    dlist(d, "frames").iter().filter_map(|v| {
        let fd = as_dict(v)?;
        Some(Frame { name: dstr(fd, "name"), filename: dstr(fd, "filename"), line: dint(fd, "line") })
    }).collect()
}

// ---- Pickle parsing ----

fn parse_snapshot(data: &[u8]) -> (Vec<Segment>, Vec<(String, i64, i64, i64, i64, Vec<Frame>)>) {
    let opts = serde_pickle::DeOptions::new().replace_recursive_structures();
    let val: Value = serde_pickle::from_slice(data, opts).expect("pickle parse failed");
    let root = as_dict(&val).expect("root not dict");

    let segments: Vec<Segment> = dlist(root, "segments").iter().filter_map(|sv| {
        let sd = as_dict(sv)?;
        let blocks = dlist(sd, "blocks").iter().filter_map(|bv| {
            let bd = as_dict(bv)?;
            Some(Block {
                address: dint(bd, "address"), size: dint(bd, "size"),
                state: dstr(bd, "state"), frames: parse_frames(bd),
            })
        }).collect();
        Some(Segment {
            address: dint(sd, "address"), total_size: dint(sd, "total_size"),
            allocated_size: dint(sd, "allocated_size"), active_size: dint(sd, "active_size"),
            segment_type: dstr(sd, "segment_type"), blocks,
        })
    }).collect();

    // Flatten device_traces — device index used to disambiguate addresses across GPUs
    let mut traces: Vec<(String, i64, i64, i64, i64, Vec<Frame>)> = Vec::new(); // (action, device_addr_key, size, time_us, raw_addr, frames)
    for (dev_idx, dt) in dlist(root, "device_traces").iter().enumerate() {
        let evs = match dt { Value::List(l) => l.as_slice(), Value::Tuple(l) => l.as_slice(), _ => continue };
        for ev in evs {
            let ed = match as_dict(ev) { Some(d) => d, None => continue };
            if dict_get(ed, "addr").is_none() { continue; }
            let addr = dint(ed, "addr");
            // Combine device index with address to form a unique key
            let device_addr = (dev_idx as i64) << 48 | (addr & 0x0000_FFFF_FFFF_FFFF);
            traces.push((dstr(ed, "action"), device_addr, dint(ed, "size"), dint(ed, "time_us"), addr, parse_frames(ed)));
        }
    }
    traces.sort_by_key(|t| t.3);

    (segments, traces)
}

// ---- Top frame ----

fn top_frame(frames: &[Frame]) -> String {
    for f in frames {
        if f.filename == "??" || f.name.contains("CUDACachingAllocator") || f.filename.contains("memory_snapshot") { continue; }
        if f.filename.contains(".py") {
            let short = f.filename.rsplit('/').next().unwrap_or(&f.filename);
            let name = f.name.split('(').next().unwrap_or(&f.name).trim();
            return format!("{} @ {}:{}", name, short, f.line);
        }
    }
    for f in frames {
        if f.filename == "??" || f.name.contains("CUDACachingAllocator") || f.filename.contains("memory_snapshot") { continue; }
        let name = f.name.split('(').next().unwrap_or(&f.name).split('<').next().unwrap_or(&f.name).trim();
        return if name.len() > 60 { format!("{}...", &name[..57]) } else { name.to_string() };
    }
    String::new()
}

// ---- Alloc/free pairing ----

fn build_allocations(traces: &[(String, i64, i64, i64, i64, Vec<Frame>)]) -> (Vec<Allocation>, i64, i64, i64) {
    if traces.is_empty() { return (vec![], 0, 0, 0); }
    struct P { raw_addr: i64, size: i64, time_us: i64, free_req: i64, frames: Vec<Frame> }
    let mut pending: HashMap<i64, P> = HashMap::new(); // key = device_addr
    let mut allocs = Vec::new();
    let mut total: i64 = 0;
    let mut peak: i64 = 0;

    for (action, device_addr, size, time_us, raw_addr, frames) in traces {
        match action.as_str() {
            "alloc" => {
                pending.insert(*device_addr, P { raw_addr: *raw_addr, size: *size, time_us: *time_us, free_req: -1, frames: frames.clone() });
                total += size; if total > peak { peak = total; }
            }
            "free_requested" => { if let Some(p) = pending.get_mut(device_addr) { p.free_req = *time_us; } }
            "free_completed" => {
                if let Some(p) = pending.remove(device_addr) {
                    allocs.push(Allocation {
                        addr: p.raw_addr, size: p.size, alloc_us: p.time_us,
                        free_requested_us: p.free_req, free_us: *time_us,
                        top_frame: top_frame(&p.frames), frames: p.frames,
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
        allocs.push(Allocation {
            addr: p.raw_addr, size: p.size, alloc_us: p.time_us, free_requested_us: p.free_req,
            free_us: -1, top_frame: top_frame(&p.frames), frames: p.frames,
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

// ---- WASM entry ----

#[wasm_bindgen]
pub fn process_snapshot(data: &[u8], rank: i32, layout_limit: i32) -> String {
    let (segments, traces) = parse_snapshot(data);
    let (allocs, t_min, t_max, peak) = build_allocations(&traces);
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

    // Blocks with strips
    j.push_str("\"blocks\":[");
    // Group strips by local_idx
    let mut strips_per: Vec<Vec<&[i64; 4]>> = vec![vec![]; n];
    for s in &strips { strips_per[s[0] as usize].push(s); }

    for i in 0..n {
        let a = &allocs[top_idx[i]];
        if i > 0 { j.push(','); }
        let free_us = if a.free_us == -1 { t_max } else { a.free_us };
        let alive = a.free_us == -1;
        j.push_str(&format!("{{\"addr\":{},\"size\":{},\"alloc_us\":{},\"free_requested_us\":{},\"free_us\":{free_us},\"alive\":{alive},\"top_frame\":{},\"idx\":{i},\"strips\":[",
            a.addr, a.size, a.alloc_us, a.free_requested_us, json_str(&a.top_frame)));
        for (si, s) in strips_per[i].iter().enumerate() {
            if si > 0 { j.push(','); }
            j.push_str(&format!("{{\"t_start\":{},\"t_end\":{},\"y_offset\":{}}}", s[1], s[2], s[3]));
        }
        j.push_str("]}");
    }
    j.push_str("],");

    // Segments for treemap / address map / top allocations
    j.push_str("\"segments\":[");
    for (si, s) in segments.iter().enumerate() {
        if si > 0 { j.push(','); }
        j.push_str(&format!("{{\"address\":{},\"total_size\":{},\"allocated_size\":{},\"segment_type\":{},\"blocks\":[",
            s.address, s.total_size, s.allocated_size, json_str(&s.segment_type)));
        for (bi, b) in s.blocks.iter().enumerate() {
            if bi > 0 { j.push(','); }
            let tf = top_frame(&b.frames);
            j.push_str(&format!("{{\"address\":{},\"size\":{},\"state\":{},\"offset_in_segment\":{},\"top_frame\":{}}}",
                b.address, b.size, json_str(&b.state), b.address - s.address, json_str(&tf)));
        }
        j.push_str("]}");
    }
    j.push_str("],");

    // Alloc details for lookup — only the top_idx allocations the main
    // thread actually renders. The rest are small enough that clicking one
    // is effectively impossible; emitting their full stacks only bloats
    // JSON, JS parse time, and the worker's detailCache.
    j.push_str("\"alloc_details\":[");
    for (i, &ai) in top_idx.iter().enumerate() {
        let a = &allocs[ai];
        if i > 0 { j.push(','); }
        j.push_str(&format!("{{\"addr\":{},\"size\":{},\"alloc_us\":{},\"free_requested_us\":{},\"free_us\":{},\"top_frame\":{},\"frames\":[",
            a.addr, a.size, a.alloc_us, a.free_requested_us, a.free_us, json_str(&a.top_frame)));
        for (fi, f) in a.frames.iter().enumerate() {
            if fi > 0 { j.push(','); }
            j.push_str(&format!("{{\"name\":{},\"filename\":{},\"line\":{}}}", json_str(&f.name), json_str(&f.filename), f.line));
        }
        j.push_str("]}");
    }
    j.push_str("]");

    j.push('}'); j
}
