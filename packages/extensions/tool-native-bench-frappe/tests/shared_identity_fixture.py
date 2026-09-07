"""Synthetic Frappe account source for the real shared Web profile fixture."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from shared_identity import Configuration, IdentityServer, SharedIdentity


async def main():
    target, state = map(Path, sys.argv[1:])
    config = Configuration(target, os.getuid(), "example.test", b"synthetic-shared-identity-key-00000",
                           {"teacher@example.test": None, "finance@example.test": None}, 600, 32, 16, 5)
    async def enabled(user):
        return json.loads(state.read_text())[user] is True
    authority = SharedIdentity(config, enabled)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    try:
        async with IdentityServer(authority).listening():
            print("shared identity fixture ready", flush=True)
            await stopped.wait()
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)


if __name__ == "__main__":
    asyncio.run(main())
