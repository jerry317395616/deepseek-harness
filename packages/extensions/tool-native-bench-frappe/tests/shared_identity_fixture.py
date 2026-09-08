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
                           {"teacher@example.test": None, "finance@example.test": None}, 600, 32, 16, 5, ("Student",))
    async def enabled(user):
        return json.loads(state.read_text())[user] is True
    async def read(user, operation, arguments):
        # Only the expensive Frappe query boundary is synthetic; routing and login checks are real.
        own_name = "synthetic-" + user.split("@")[0]
        if operation == "frappe_describe_doctype":
            return {"doctype": "Student", "fields": [{"fieldname": "name"}]}
        document = {"name": own_name}
        if operation == "frappe_get_document":
            return {"doctype": "Student", "name": arguments["name"],
                    "document": document if arguments["name"] == own_name else None}
        return {"doctype": "Student", "rows": [document]}
    class ApplicationFixture(SharedIdentity):
        """Synthetic application receipts; no business rules or Frappe writes."""
        def __init__(self):
            super().__init__(config, enabled, read=read)
            self.previews = {}

        async def execute(self, request):
            if request.get("operation") != "application":
                return await super().execute(request)
            value = request["value"]
            principal = await self.resolve(value["credential"])
            if principal is None:
                raise PermissionError("not admitted")
            key = (value["credential"], value["sessionId"])
            if value["action"] == "capabilities":
                return {"previews": True}
            if value["action"] == "preview":
                self.previews[key] = {"preview_id": "synthetic-preview", "digest": "a" * 64,
                    "state": "awaiting_confirmation"}
                return self.previews[key]
            if value["action"] == "review":
                return {"items": [self.previews[key]] if key in self.previews else []}
            if value["action"] == "confirm" and key in self.previews:
                replayed = self.previews[key]["state"] == "succeeded"
                self.previews[key]["state"] = "succeeded"
                return {"state": "succeeded", "replayed": replayed}
            raise ValueError("unsupported application action")
    authority = ApplicationFixture()
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
