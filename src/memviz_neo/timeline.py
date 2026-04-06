"""Build timeline data from device traces: pair alloc/free, compute memory time series."""

from dataclasses import dataclass

from .parser import Frame, Snapshot


@dataclass
class Allocation:
    addr: int
    size: int
    alloc_us: int
    free_us: int  # -1 if still alive
    top_frame: str
    frames: list[Frame]


@dataclass
class Strip:
    t_start: int
    t_end: int
    y_offset: int


@dataclass
class PolygonBlock:
    addr: int
    size: int
    alloc_us: int
    free_us: int
    alive: bool
    top_frame: str
    idx: int
    strips: list[Strip]


@dataclass
class TimelineData:
    allocations: list[Allocation]
    usage_series: list[tuple[int, int]]  # (time_us, total_bytes)
    annotations: list[dict]  # {stage, name, time_us}
    time_min: int
    time_max: int
    peak_bytes: int


def _extract_top_frame(frames) -> str:
    for f in frames:
        if f.filename == "??" or "CUDACachingAllocator" in f.name or "memory_snapshot" in f.filename:
            continue
        if ".py" in f.filename:
            short = f.filename.rsplit("/", 1)[-1]
            name = f.name.split("(")[0].strip()
            return f"{name} @ {short}:{f.line}"
    for f in frames:
        if f.filename == "??" or "CUDACachingAllocator" in f.name or "memory_snapshot" in f.filename:
            continue
        name = f.name.split("(")[0].split("<")[0].strip()
        if len(name) > 60:
            name = name[:57] + "..."
        return name
    return ""


def build_timeline(snapshot: Snapshot) -> TimelineData:
    traces = snapshot.traces
    if not traces:
        return TimelineData([], [], [], 0, 0, 0)

    # pair alloc/free
    pending: dict[int, dict] = {}  # addr -> {size, time_us, frames}
    allocations: list[Allocation] = []
    events: list[tuple[int, int]] = []  # (time_us, delta_bytes)

    for t in traces:
        if t.action == "alloc":
            pending[t.addr] = {"size": t.size, "time_us": t.time_us, "frames": t.frames}
            events.append((t.time_us, t.size))
        elif t.action == "free_completed":
            if t.addr in pending:
                info = pending.pop(t.addr)
                allocations.append(Allocation(
                    addr=t.addr,
                    size=info["size"],
                    alloc_us=info["time_us"],
                    free_us=t.time_us,
                    top_frame=_extract_top_frame(info["frames"]),
                    frames=info["frames"],
                ))
                events.append((t.time_us, -info["size"]))

    # still-alive allocations
    t_max_trace = max(t.time_us for t in traces)
    for addr, info in pending.items():
        allocations.append(Allocation(
            addr=addr,
            size=info["size"],
            alloc_us=info["time_us"],
            free_us=-1,
            top_frame=_extract_top_frame(info["frames"]),
            frames=info["frames"],
        ))

    # build cumulative usage series
    events.sort()
    usage_series = []
    total = 0
    peak = 0
    for time_us, delta in events:
        total += delta
        if total > peak:
            peak = total
        usage_series.append((time_us, total))

    # downsample if too many points (keep at most ~2000 for frontend)
    if len(usage_series) > 2000:
        step = len(usage_series) // 2000
        downsampled = []
        for i in range(0, len(usage_series), step):
            chunk = usage_series[i : i + step]
            # keep the max point in each chunk
            max_point = max(chunk, key=lambda p: p[1])
            downsampled.append(chunk[0])
            if max_point != chunk[0]:
                downsampled.append(max_point)
        if usage_series[-1] not in downsampled:
            downsampled.append(usage_series[-1])
        usage_series = downsampled

    # annotations within trace time range (with some padding)
    t_min = min(t.time_us for t in traces)
    annots = [
        {"stage": a.stage, "name": a.name, "time_us": a.time_us}
        for a in snapshot.annotations
        if t_min <= a.time_us <= t_max_trace
    ]

    return TimelineData(
        allocations=allocations,
        usage_series=usage_series,
        annotations=annots,
        time_min=t_min,
        time_max=t_max_trace,
        peak_bytes=peak,
    )


def build_polygon_layout(allocations: list[Allocation], time_max: int, limit: int = 300) -> list[PolygonBlock]:
    """Build sliding polygon layout from allocations.

    Maintains a time-ordered stack: alloc pushes to top, free removes and slides
    everything above down. Each allocation's y_offset is piecewise-constant,
    changing only when something below it is freed.
    """
    top = sorted(allocations, key=lambda a: -a.size)[:limit]
    if not top:
        return []

    _ALLOC, _FREE = 0, 1

    events: list[tuple[int, int, int, int]] = []  # (time, type, id, size)
    for i, a in enumerate(top):
        events.append((a.alloc_us, _ALLOC, i, a.size))
        free_t = a.free_us if a.free_us != -1 else time_max + 1
        if a.free_us != -1:
            events.append((free_t, _FREE, i, a.size))
    # Sort: time asc, free before alloc at same time
    events.sort(key=lambda e: (e[0], e[1]))

    # Stack: list of (id, size), index 0 = bottom (earliest alloc)
    stack: list[tuple[int, int]] = []
    strip_start: dict[int, int] = {}  # id -> strip start time
    y_offsets: dict[int, int] = {}  # id -> current y_offset
    result: dict[int, list[Strip]] = {i: [] for i in range(len(top))}

    for time, etype, alloc_id, size in events:
        if etype == _ALLOC:
            y_off = sum(s for _, s in stack)
            stack.append((alloc_id, size))
            strip_start[alloc_id] = time
            y_offsets[alloc_id] = y_off
        else:
            pos = -1
            for i, (aid, _) in enumerate(stack):
                if aid == alloc_id:
                    pos = i
                    break
            if pos == -1:
                continue

            # Close strip for freed allocation
            if strip_start[alloc_id] < time:
                result[alloc_id].append(Strip(strip_start[alloc_id], time, y_offsets[alloc_id]))
            del strip_start[alloc_id]
            del y_offsets[alloc_id]

            freed_size = stack[pos][1]
            stack.pop(pos)

            # Everything above slides down
            for i in range(pos, len(stack)):
                above_id = stack[i][0]
                old_y = y_offsets[above_id]
                if strip_start[above_id] < time:
                    result[above_id].append(Strip(strip_start[above_id], time, old_y))
                strip_start[above_id] = time
                y_offsets[above_id] = old_y - freed_size

    # Close remaining strips (still-alive allocations)
    for alloc_id, t_start in strip_start.items():
        if t_start < time_max:
            result[alloc_id].append(Strip(t_start, time_max, y_offsets[alloc_id]))

    blocks = []
    for i, a in enumerate(top):
        blocks.append(PolygonBlock(
            addr=a.addr,
            size=a.size,
            alloc_us=a.alloc_us,
            free_us=a.free_us if a.free_us != -1 else time_max,
            alive=a.free_us == -1,
            top_frame=a.top_frame,
            idx=i,
            strips=result[i],
        ))
    return blocks
