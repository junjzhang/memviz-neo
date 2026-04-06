"""Aggregate snapshot data into structures suitable for visualization."""

from __future__ import annotations

from dataclasses import dataclass

from .parser import Snapshot


@dataclass
class TreemapNode:
    name: str
    size: int  # bytes
    children: list[TreemapNode] | None = None
    address: int | None = None
    state: str | None = None
    top_frame: str | None = None


@dataclass
class SegmentInfo:
    address: int
    total_size: int
    allocated_size: int
    segment_type: str
    blocks: list[BlockInfo]


@dataclass
class BlockInfo:
    address: int
    size: int
    state: str
    offset_in_segment: int  # relative to segment start
    top_frame: str | None = None


@dataclass
class RankSummary:
    rank: int
    total_reserved: int
    total_allocated: int
    total_active: int
    segment_count: int
    block_count: int
    active_bytes: int
    inactive_bytes: int
    treemap: TreemapNode
    segments: list[SegmentInfo]


def _top_user_frame(block) -> str | None:
    for f in block.frames:
        if f.filename == "??" or "CUDACachingAllocator" in f.name:
            continue
        if "memory_snapshot" in f.filename:
            continue
        if ".py" in f.filename:
            short = f.filename.rsplit("/", 1)[-1]
            name = f.name.split("(")[0].strip()
            return f"{name} @ {short}:{f.line}"
    for f in block.frames:
        if f.filename == "??" or "CUDACachingAllocator" in f.name:
            continue
        if "memory_snapshot" in f.filename:
            continue
        name = f.name.split("(")[0].split("<")[0].strip()
        if len(name) > 80:
            name = name[:77] + "..."
        return name
    return None


def build_treemap(snapshot: Snapshot) -> TreemapNode:
    """Build treemap: root -> segment_type -> segment -> blocks (>1MB)."""
    type_buckets: dict[str, list[TreemapNode]] = {}

    for seg in snapshot.segments:
        seg_children = []
        small_total = 0

        for block in seg.blocks:
            if block.state != "active_allocated":
                continue
            if block.size >= 1_048_576:  # >1MB: individual node
                seg_children.append(
                    TreemapNode(
                        name=_top_user_frame(block) or f"0x{block.address:x}",
                        size=block.size,
                        address=block.address,
                        state=block.state,
                        top_frame=_top_user_frame(block),
                    )
                )
            else:
                small_total += block.size

        if small_total > 0:
            seg_children.append(TreemapNode(name="(small blocks)", size=small_total))

        if not seg_children:
            continue

        seg_children.sort(key=lambda n: -n.size)
        seg_node = TreemapNode(
            name=f"seg 0x{seg.address:x}",
            size=sum(c.size for c in seg_children),
            address=seg.address,
            children=seg_children,
        )
        type_buckets.setdefault(seg.segment_type, []).append(seg_node)

    root_children = []
    for seg_type, segs in sorted(type_buckets.items()):
        segs.sort(key=lambda n: -n.size)
        root_children.append(
            TreemapNode(
                name=seg_type,
                size=sum(s.size for s in segs),
                children=segs,
            )
        )

    return TreemapNode(
        name="GPU Memory",
        size=sum(c.size for c in root_children),
        children=sorted(root_children, key=lambda n: -n.size),
    )


def build_address_map(snapshot: Snapshot) -> list[SegmentInfo]:
    """Build address-space map for fragmentation view."""
    result = []
    for seg in snapshot.segments:
        blocks = []
        for block in seg.blocks:
            blocks.append(
                BlockInfo(
                    address=block.address,
                    size=block.size,
                    state=block.state,
                    offset_in_segment=block.address - seg.address,
                    top_frame=_top_user_frame(block),
                )
            )
        result.append(
            SegmentInfo(
                address=seg.address,
                total_size=seg.total_size,
                allocated_size=seg.allocated_size,
                segment_type=seg.segment_type,
                blocks=sorted(blocks, key=lambda b: b.address),
            )
        )
    return sorted(result, key=lambda s: -s.total_size)


def build_rank_summary(snapshot: Snapshot) -> RankSummary:
    active = sum(
        b.size for s in snapshot.segments for b in s.blocks if b.state == "active_allocated"
    )
    inactive = sum(
        b.size for s in snapshot.segments for b in s.blocks if b.state == "inactive"
    )
    return RankSummary(
        rank=snapshot.rank,
        total_reserved=sum(s.total_size for s in snapshot.segments),
        total_allocated=sum(s.allocated_size for s in snapshot.segments),
        total_active=sum(s.active_size for s in snapshot.segments),
        segment_count=len(snapshot.segments),
        block_count=sum(len(s.blocks) for s in snapshot.segments),
        active_bytes=active,
        inactive_bytes=inactive,
        treemap=build_treemap(snapshot),
        segments=build_address_map(snapshot),
    )
