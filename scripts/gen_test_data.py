"""Generate synthetic PyTorch memory snapshot pickle files for performance testing."""

import os
import pickle
import random
import argparse


def gen_snapshot(rank: int, n_events: int = 20000, seed: int = 42) -> dict:
    """Build one synthetic rank snapshot with alloc/free trace events + a tail segment."""
    rng = random.Random(seed + rank)
    t = 0
    pending: dict[int, tuple[int, int, list[dict]]] = {}
    traces: list[dict] = []
    addr_counter = 0x7F0000000000 + rank * 0x100000000

    for _ in range(n_events):
        t += rng.randint(1, 100)

        if pending and rng.random() < 0.45:
            addr = rng.choice(list(pending.keys()))
            size, _alloc_time, frames = pending.pop(addr)
            traces.append({
                "action": "free_requested",
                "addr": addr,
                "size": size,
                "stream": 0,
                "time_us": t,
                "frames": frames,
            })
            t += rng.randint(0, 50)
            traces.append({
                "action": "free_completed",
                "addr": addr,
                "size": size,
                "stream": 0,
                "time_us": t,
                "frames": frames,
            })
        else:
            size = rng.choice([512, 1024, 4096, 65536, 262144, 1048576, 4194304, 16777216, 67108864])
            addr_counter += rng.randint(1, 1000) * 512
            addr = addr_counter
            frames = [
                {
                    "name": f"func_{rng.randint(0, 200)}",
                    "filename": f"model/layer_{rng.randint(0, 20)}.py",
                    "line": rng.randint(1, 500),
                },
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

    blocks = [
        {
            "address": addr,
            "size": size,
            "requested_size": size,
            "state": "active_allocated",
            "frames": frames,
        }
        for addr, (size, _, frames) in pending.items()
    ]

    segment = {
        "device": 0,
        "address": 0x7F0000000000 + rank * 0x100000000,
        "total_size": sum(b["size"] for b in blocks) + 1048576,
        "allocated_size": sum(b["size"] for b in blocks),
        "active_size": sum(b["size"] for b in blocks),
        "stream": 0,
        "segment_type": "large",
        "blocks": blocks,
    }

    return {
        "segments": [segment],
        "device_traces": [traces],
        "external_annotations": [],
        "allocator_settings": {},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ranks", type=int, default=32, help="Number of rank files to generate")
    parser.add_argument("--events", type=int, default=20000, help="Trace events per rank")
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "..", "test_data"),
        help="Output directory",
    )
    parser.add_argument("--clean", action="store_true", help="Remove existing rank*.pickle first")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    if args.clean:
        for name in os.listdir(out_dir):
            if name.startswith("rank") and name.endswith("_memory_snapshot.pickle"):
                os.remove(os.path.join(out_dir, name))
        print(f"cleaned existing rank files in {out_dir}")

    for rank in range(args.ranks):
        path = os.path.join(out_dir, f"rank{rank}_memory_snapshot.pickle")
        snap = gen_snapshot(rank, args.events)
        with open(path, "wb") as f:
            pickle.dump(snap, f, protocol=4)
        if rank % 8 == 0 or rank == args.ranks - 1:
            print(f"rank {rank + 1}/{args.ranks} done")

    print(f"Generated {args.ranks} snapshots x {args.events} events each in {out_dir}/")


if __name__ == "__main__":
    main()
