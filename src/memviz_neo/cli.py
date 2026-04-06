"""CLI entry point for memviz-neo."""

import os
import signal
import subprocess
import sys
from pathlib import Path

import click


@click.group()
def cli():
    pass


@cli.command()
@click.argument("directory", type=click.Path(exists=True, path_type=Path))
@click.option("--host", default="0.0.0.0", help="Bind address")
@click.option("--port", default=8377, help="Port number")
def serve(directory: Path, host: str, port: int):
    """Load snapshot data and start the API server."""
    import uvicorn

    from .server import app, load_data

    click.echo(f"Loading snapshots from {directory}...")
    load_data(directory)
    click.echo(f"Starting server on {host}:{port}")
    uvicorn.run(app, host=host, port=port)


@cli.command()
@click.argument("directory", type=click.Path(exists=True, path_type=Path))
@click.option("--port", default=8377, help="API server port")
@click.option("--vite-port", default=5173, help="Vite dev server port")
def dev(directory: Path, port: int, vite_port: int):
    """Start both API server and Vite dev server."""
    import uvicorn

    from .server import app, load_data

    click.echo(f"Loading snapshots from {directory}...")
    load_data(directory)

    project_root = Path(__file__).resolve().parent.parent.parent
    web_dir = project_root / "web"

    # start vite dev server as subprocess
    vite_env = os.environ.copy()
    vite_proc = subprocess.Popen(
        ["pnpm", "dev", "--port", str(vite_port)],
        cwd=web_dir,
        env=vite_env,
    )

    def cleanup(*_args):
        vite_proc.terminate()
        vite_proc.wait()
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    click.echo(f"API server on http://localhost:{port}")
    click.echo(f"Frontend on http://localhost:{vite_port}")

    try:
        uvicorn.run(app, host="0.0.0.0", port=port)
    finally:
        vite_proc.terminate()
        vite_proc.wait()


if __name__ == "__main__":
    cli()
