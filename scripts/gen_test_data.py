"""Generate synthetic PyTorch memory snapshot pickle files for performance testing."""

import pickle
import random
import os

def gen_snapshot(rank: int, n_events: int = 50000, seed: int = 42):
    rng = random.Random(seed + rank)
    t = 0
    pending = {}  # addr -> (size, alloc_time, frames)
    traces = []
    addr_counter = 0x7f0000000000 + rank * 0x100000000

    for _ in range(n_events):
        t += rng.randint(1, 100)

        if pending and rng.random() < 0.45:
            # free a random pending allocation
            addr = rng.choice(list(pending.keys()))
            size, alloc_time, frames = pending.pop(addr)
            # free_requested
            traces.append({
                "action": "free_requested",
                "addr": addr,
                "size": size,
                "stream": 0,
                "time_us": t,
                "frames": frames,
            })
            t += rng.randint(0, 50)
            # free_completed
            traces.append({
                "action": "free_completed",
                "addr": addr,
                "size": size,
                "stream": 0,
                "time_us": t,
                "frames": frames,
            })
        else:
            # alloc
            size = rng.choice([512, 1024, 4096, 65536, 262144, 1048576, 4194304, 16777216, 67108864])
            addr_counter += rng.randint(1, 1000) * 512
            addr = addr_counter
            frames = [
                {"name": f"func_{rng.randint(0,200)}", "filename": f"model/layer_{rng.randint(0,20)}.py", "line": rng.randint(1, 500)},
                {"name": "forward", "filename": "torch/nn/modules/module.py", "line": 1500},
            ]
            traces.append({
                "action": "alloc",
                "addr": addr,
                "size": size,
                "stream": 0,
                "time_us": t,
                "frames": frames,
            })
            pending[addr] = (size, t, frames)

    # Build segments from still-alive allocations
    blocks = []
    for addr, (size, _, frames) in pending.items():
        blocks.append({
            "address": addr,
            "size": size,
            "requested_size": size,
            "state": "active_allocated",
            "frames": frames,
        })

    segment = {
        "device": 0,
        "address": 0x7f0000000000 + rank * 0x100000000,
        "total_size": sum(b["size"] for b in blocks) + 1048576,
        "allocated_size": sum(b["size"] for b in blocks),
        "active_size": sum(b["size"] for b in blocks),
        "stream": 0,
        "segment_type": "large",
        "blocks": blocks,
    }

    snapshot = {
        "segments": [segment],
        "device_traces": [traces],
        "external_annotations": [],
        "allocator_settings": {},
    }
    return snapshot


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "test_data")
    os.makedirs(out_dir, exist_ok=True)

    n_ranks = 128
    n_events = 50000

    for rank in range(n_ranks):
        path = os.path.join(out_dir, f"rank{rank}_memory_snapshot.pickle")
        snap = gen_snapshot(rank, n_events)
        with open(path, "wb") as f:
            pickle.dump(snap, f, protocol=4)
        if rank % 16 == 0:
            print(f"rank {rank}/{n_ranks} done")

    print(f"Generated {n_ranks} snapshots with {n_events} events each in {out_dir}/")


if __name__ == "__main__":
    main()
