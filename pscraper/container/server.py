from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
from contextlib import suppress
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger("pscraper.host")
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# A single interactive scraper process is intentional: the original CLI and its
# output directory are designed as one terminal session, not a multi-tenant API.
terminal_lock = asyncio.Lock()


def _safe_runtime_header() -> str:
    return (
        "pscraper@cloud\n"
        "OS     // Linux container\n"
        "Shell  // interactive Python CLI\n"
        f"Python // {sys.version.split()[0]}\n"
        "Storage// persistent R2 mount\n"
        "\n"
    )


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "pscraper"})


@app.websocket("/terminal")
async def terminal(websocket: WebSocket) -> None:
    await websocket.accept()
    if terminal_lock.locked():
        await websocket.send_text("pscraper is already running in another terminal session.\n")
        await websocket.close(code=1013, reason="Terminal busy")
        return

    async with terminal_lock:
        process: asyncio.subprocess.Process | None = None
        try:
            await websocket.send_text(_safe_runtime_header())
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-u",
                "-m",
                "scraper.main",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd="/app",
                env=os.environ.copy(),
            )
            assert process.stdout is not None
            assert process.stdin is not None

            async def stream_output() -> None:
                while True:
                    chunk = await process.stdout.read(2048)
                    if not chunk:
                        break
                    await websocket.send_text(chunk.decode("utf-8", errors="replace"))

            async def stream_input() -> None:
                while True:
                    message = await websocket.receive_text()
                    try:
                        payload: Any = json.loads(message)
                    except json.JSONDecodeError:
                        payload = {"type": "input", "data": message}

                    kind = payload.get("type") if isinstance(payload, dict) else "input"
                    if kind == "input":
                        value = payload.get("data", "") if isinstance(payload, dict) else str(payload)
                        if not isinstance(value, str) or len(value) > 4096:
                            continue
                        process.stdin.write(value.encode("utf-8"))
                        await process.stdin.drain()
                    elif kind == "interrupt":
                        with suppress(ProcessLookupError):
                            process.send_signal(signal.SIGINT)
                    elif kind == "terminate":
                        with suppress(ProcessLookupError):
                            process.terminate()
                        return

            output_task = asyncio.create_task(stream_output())
            input_task = asyncio.create_task(stream_input())
            wait_task = asyncio.create_task(process.wait())
            done, pending = await asyncio.wait(
                {output_task, input_task, wait_task},
                return_when=asyncio.FIRST_COMPLETED,
            )

            # A disconnected browser must not leave an unattended scraper running.
            if (input_task in done or output_task in done) and not wait_task.done():
                with suppress(ProcessLookupError):
                    process.terminate()
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(wait_task, timeout=5)
                if not wait_task.done():
                    with suppress(ProcessLookupError):
                        process.kill()
                    await wait_task

            if wait_task in done or output_task in done:
                if not wait_task.done():
                    await wait_task
                if not output_task.done():
                    await output_task

            for task in done:
                if task is not wait_task:
                    with suppress(Exception):
                        await task

            for task in pending:
                task.cancel()
            for task in pending:
                with suppress(asyncio.CancelledError, WebSocketDisconnect):
                    await task

            with suppress(Exception):
                await websocket.send_text(
                    f"\n[pscraper process exited: {process.returncode}]\n"
                )
                await websocket.close()
        except WebSocketDisconnect:
            if process and process.returncode is None:
                with suppress(ProcessLookupError):
                    process.terminate()
                with suppress(Exception):
                    await asyncio.wait_for(process.wait(), timeout=5)
        except Exception as exc:
            log.warning("terminal session ended: %s", type(exc).__name__)
            if process and process.returncode is None:
                with suppress(ProcessLookupError):
                    process.terminate()
                with suppress(Exception):
                    await asyncio.wait_for(process.wait(), timeout=5)
            with suppress(Exception):
                await websocket.send_text("\n[terminal connection ended]\n")
                await websocket.close(code=1011)
