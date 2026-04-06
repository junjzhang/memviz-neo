"""Categorize memory blocks by semantic type using stack frame heuristics."""

from .parser import Block, Frame, Snapshot

# Categories ordered by priority — first match wins.
CATEGORY_RULES: list[tuple[str, list[str]]] = [
    ("comm_buffer", [
        "all_to_all", "all_gather", "all_reduce", "reduce_scatter",
        "nccl", "ProcessGroup", "broadcast", "_collectives",
    ]),
    ("optimizer_state", [
        "optimizer", "Optimizer", "adam", "Adam", "sgd", "SGD",
        "foreach_", "step", "zero_grad",
    ]),
    ("gradient", [
        "backward", "autograd", "AccumulateGrad", "grad_fn",
        "reduce_grad", "foreach_reduce",
    ]),
    ("activation", [
        "forward", "checkpoint", "activation", "save_for_backward",
    ]),
    ("fsdp_param", [
        "fsdp", "FSDP", "_fsdp_param", "alloc_storage", "alloc_all_gather",
        "FullyShardedDataParallel",
    ]),
    ("weight", [
        "load_state_dict", "from_pretrained", "init_weights",
        "Parameter", "parameter",
    ]),
]


def _match_frames(frames: list[Frame], keywords: list[str]) -> bool:
    for frame in frames:
        text = f"{frame.name} {frame.filename}"
        for kw in keywords:
            if kw in text:
                return True
    return False


def categorize_block(block: Block) -> str:
    if not block.frames:
        return "unknown"

    for category, keywords in CATEGORY_RULES:
        if _match_frames(block.frames, keywords):
            return category

    return "unknown"


def categorize_snapshot(snapshot: Snapshot) -> dict[int, str]:
    """Return mapping of block address → category for all blocks in snapshot."""
    result = {}
    for seg in snapshot.segments:
        for block in seg.blocks:
            result[block.address] = categorize_block(block)
    return result
