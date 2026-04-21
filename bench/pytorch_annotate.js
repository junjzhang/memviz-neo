function annotate_snapshot(snapshot) {
  snapshot.segment_version = version_space();
  snapshot.block_version = version_space();
  snapshot.categories = [];
  const empty_list = [];
  let next_stream = 1;
  const stream_names = {0: 0};
  function stream_name(s) {
    if (!(s in stream_names)) {
      stream_names[s] = next_stream++;
    }
    return stream_names[s];
  }
  const new_traces = [];
  for (const device_trace of snapshot.device_traces) {
    const new_trace = [];
    new_traces.push(new_trace);
    for (const t of device_trace) {
      if (!('frames' in t)) {
        t.frames = empty_list;
      }
      // set unique version for each time an address is used
      // so that ctrl-f can be used to search for the beginning
      // and end of allocations and segments
      t.stream = stream_name(t.stream);
      switch (t.action) {
        case 'free_completed':
          t.version = snapshot.block_version(t.addr, true);
          if (new_trace.length > 0) {
            // elide free_requested/free_completed into a single event
            const prev = new_trace.at(-1);
            if (prev.action === 'free_requested' && prev.addr === t.addr) {
              prev.action = 'free';
              continue;
            }
          }
          break;
        case 'free_requested':
        case 'alloc':
          t.version = snapshot.block_version(t.addr, false);
          break;
        case 'segment_free':
        case 'segment_unmap':
          t.version = snapshot.segment_version(t.addr, true);
          break;
        case 'segment_alloc':
        case 'segment_map':
          t.version = snapshot.segment_version(t.addr, false);
          break;
        default:
          break;
      }
      if ('category' in t && !snapshot.categories.includes(t.category)) {
        snapshot.categories.push(t.category);
      }
      t.idx = new_trace.length;
      new_trace.push(t);
    }
  }
  snapshot.device_traces = new_traces;
  // if every event was on the default stream, we elide stream printing
  if (next_stream == 1) {
    for (const device_trace of snapshot.device_traces) {
      for (const t of device_trace) {
        t.stream = null;
      }
    }
  }

  for (const seg of snapshot.segments) {
    seg.stream = stream_name(seg.stream);
    seg.version = snapshot.segment_version(seg.address, false);
    let addr = seg.address;
    for (const b of seg.blocks) {
      b.addr = addr;
      if (!('frames' in b)) {
        // legacy format where 'requested_size' may be missing
        // and frames might be in history rather than directly on block
        if ('history' in b) {
          b.frames = b.history[0].frames || empty_list;
          b.requested_size = b.requested_size || b.history[0].real_size;
        } else {
          b.frames = empty_list;
          b.requested_size = b.requested_size || b.size;
        }
      }
      b.version = snapshot.block_version(b.addr, false);
      b.segment_pool_id = seg.segment_pool_id;
      // Note [BigInt and Number Safe Arithmetic]
      // Device pointer addresses may be represented as either Number or BigInt.
      // Use explicit conversions to perform arithmetic safely and avoid mixing
      // BigInt and Number types, which would otherwise trigger JS type errors.
      addr += typeof addr === "bigint" ? BigInt(b.size) : b.size;
    }
  }

  if (
    snapshot.categories.length > 0 &&
    !snapshot.categories.includes('unknown')
  ) {
    snapshot.categores.push('unknown');
  }
}
