"""FastAPI server for serving snapshot data to the web frontend."""

import dataclasses
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .aggregate import RankSummary, _top_user_frame, build_rank_summary
from .parser import Snapshot, load_snapshot_dir
from .timeline import PolygonBlock, TimelineData, build_polygon_layout, build_timeline

app = FastAPI(title="memviz-neo")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_snapshots: dict[int, Snapshot] = {}
_summaries: dict[int, RankSummary] = {}
_timelines: dict[int, TimelineData] = {}
_polygon_blocks: dict[int, list[PolygonBlock]] = {}


def _to_dict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _to_dict(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, list):
        return [_to_dict(i) for i in obj]
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    return obj


def load_data(directory: Path):
    global _snapshots, _summaries, _timelines, _polygon_blocks
    snapshots = load_snapshot_dir(directory)
    for snap in snapshots:
        _snapshots[snap.rank] = snap
        _summaries[snap.rank] = build_rank_summary(snap)
        tl = build_timeline(snap)
        _timelines[snap.rank] = tl
        _polygon_blocks[snap.rank] = build_polygon_layout(tl.allocations, tl.time_max)


@app.get("/api/ranks")
def list_ranks():
    return sorted(_summaries.keys())


@app.get("/api/summary/{rank}")
def get_summary(rank: int):
    if rank not in _summaries:
        raise HTTPException(404, f"rank {rank} not found")
    s = _summaries[rank]
    return {
        "rank": s.rank,
        "total_reserved": s.total_reserved,
        "total_allocated": s.total_allocated,
        "total_active": s.total_active,
        "segment_count": s.segment_count,
        "block_count": s.block_count,
        "active_bytes": s.active_bytes,
        "inactive_bytes": s.inactive_bytes,
    }


@app.get("/api/treemap/{rank}")
def get_treemap(rank: int):
    if rank not in _summaries:
        raise HTTPException(404, f"rank {rank} not found")
    return _to_dict(_summaries[rank].treemap)


@app.get("/api/segments/{rank}")
def get_segments(rank: int):
    if rank not in _summaries:
        raise HTTPException(404, f"rank {rank} not found")
    return _to_dict(_summaries[rank].segments)


@app.get("/api/annotations/{rank}")
def get_annotations(rank: int):
    if rank not in _snapshots:
        raise HTTPException(404, f"rank {rank} not found")
    snap = _snapshots[rank]
    return [
        {"stage": a.stage, "name": a.name, "device": a.device, "time_us": a.time_us}
        for a in snap.annotations
    ]


@app.get("/api/top_allocations/{rank}")
def get_top_allocations(rank: int, limit: int = 50):
    if rank not in _snapshots:
        raise HTTPException(404, f"rank {rank} not found")
    snap = _snapshots[rank]

    blocks = []
    for seg in snap.segments:
        for block in seg.blocks:
            if block.state != "active_allocated":
                continue
            blocks.append({
                "address": block.address,
                "size": block.size,
                "source": _top_user_frame(block),
                "segment_type": seg.segment_type,
            })

    blocks.sort(key=lambda b: -b["size"])
    return blocks[:limit]


@app.get("/api/timeline/{rank}")
def get_timeline(rank: int):
    if rank not in _timelines:
        raise HTTPException(404, f"rank {rank} not found")
    tl = _timelines[rank]
    return {
        "usage_series": tl.usage_series,
        "annotations": tl.annotations,
        "time_min": tl.time_min,
        "time_max": tl.time_max,
        "peak_bytes": tl.peak_bytes,
        "allocation_count": len(tl.allocations),
    }


@app.get("/api/timeline_blocks/{rank}")
def get_timeline_blocks(rank: int):
    """Return top allocations with precomputed polygon strips for sliding layout."""
    if rank not in _polygon_blocks:
        raise HTTPException(404, f"rank {rank} not found")
    blocks = _polygon_blocks[rank]
    return {
        "blocks": [
            {
                "addr": b.addr,
                "size": b.size,
                "alloc_us": b.alloc_us,
                "free_us": b.free_us,
                "alive": b.alive,
                "top_frame": b.top_frame,
                "idx": b.idx,
                "strips": [{"t_start": s.t_start, "t_end": s.t_end, "y_offset": s.y_offset} for s in b.strips],
            }
            for b in blocks
        ]
    }


@app.get("/api/allocation_detail/{rank}/{addr}")
def get_allocation_detail(rank: int, addr: int):
    """Return full stack trace for a specific allocation."""
    if rank not in _timelines:
        raise HTTPException(404, f"rank {rank} not found")
    tl = _timelines[rank]

    for a in tl.allocations:
        if a.addr == addr:
            return {
                "addr": a.addr,
                "size": a.size,
                "alloc_us": a.alloc_us,
                "free_us": a.free_us,
                "top_frame": a.top_frame,
                "frames": [
                    {"name": f.name, "filename": f.filename, "line": f.line}
                    for f in a.frames
                ],
            }
    raise HTTPException(404, f"allocation 0x{addr:x} not found")


@app.get("/api/multi_rank_overview")
def multi_rank_overview():
    result = []
    for rank in sorted(_summaries.keys()):
        s = _summaries[rank]
        result.append({
            "rank": s.rank,
            "total_reserved": s.total_reserved,
            "total_allocated": s.total_allocated,
            "total_active": s.total_active,
            "segment_count": s.segment_count,
            "block_count": s.block_count,
            "active_bytes": s.active_bytes,
            "inactive_bytes": s.inactive_bytes,
        })
    return result
