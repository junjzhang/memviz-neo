"""Parse PyTorch memory snapshot pickle files into structured data."""

import pickle
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Frame:
    name: str
    filename: str
    line: int


@dataclass
class Block:
    address: int
    size: int
    requested_size: int
    state: str  # "active_allocated" or "inactive"
    frames: list[Frame]


@dataclass
class Segment:
    device: int
    address: int
    total_size: int
    allocated_size: int
    active_size: int
    stream: int
    segment_type: str  # "small" or "large"
    blocks: list[Block]


@dataclass
class Annotation:
    stage: str  # "START" or "END"
    name: str
    device: int
    time_us: int


@dataclass
class TraceEvent:
    action: str  # "alloc", "free_requested", "free_completed", "segment_alloc", "segment_free"
    addr: int
    size: int
    stream: int
    time_us: int
    frames: list[Frame]


@dataclass
class Snapshot:
    rank: int
    segments: list[Segment]
    annotations: list[Annotation]
    traces: list[TraceEvent]
    allocator_settings: dict = field(default_factory=dict)


def _parse_frames(raw_frames: list[dict]) -> list[Frame]:
    return [Frame(f["name"], f["filename"], f["line"]) for f in raw_frames]


def _parse_block(raw: dict) -> Block:
    return Block(
        address=raw["address"],
        size=raw["size"],
        requested_size=raw.get("requested_size", raw["size"]),
        state=raw["state"],
        frames=_parse_frames(raw.get("frames", [])),
    )


def _parse_segment(raw: dict) -> Segment:
    return Segment(
        device=raw["device"],
        address=raw["address"],
        total_size=raw["total_size"],
        allocated_size=raw["allocated_size"],
        active_size=raw["active_size"],
        stream=raw["stream"],
        segment_type=raw["segment_type"],
        blocks=[_parse_block(b) for b in raw.get("blocks", [])],
    )


def load_snapshot(path: Path, rank: int) -> Snapshot:
    with open(path, "rb") as f:
        data = pickle.load(f)

    segments = [_parse_segment(s) for s in data.get("segments", [])]

    annotations = [
        Annotation(a["stage"], a["name"], a["device"], a["time_us"])
        for a in data.get("external_annotations", [])
    ]

    traces = []
    for device_traces in data.get("device_traces", []):
        for t in device_traces:
            if not isinstance(t, dict) or "addr" not in t:
                continue
            traces.append(
                TraceEvent(
                    action=t["action"],
                    addr=t["addr"],
                    size=t["size"],
                    stream=t.get("stream", 0),
                    time_us=t["time_us"],
                    frames=_parse_frames(t.get("frames", [])),
                )
            )

    return Snapshot(
        rank=rank,
        segments=segments,
        annotations=annotations,
        traces=sorted(traces, key=lambda t: t.time_us),
        allocator_settings=data.get("allocator_settings", {}),
    )


def load_snapshot_dir(directory: Path) -> list[Snapshot]:
    files = sorted(directory.glob("rank*_memory_snapshot.pickle"))
    snapshots = []
    for f in files:
        rank = int(f.name.split("rank")[1].split("_")[0])
        snapshots.append(load_snapshot(f, rank))
    return snapshots
