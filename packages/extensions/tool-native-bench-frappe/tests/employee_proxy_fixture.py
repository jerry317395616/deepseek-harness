"""Private real-Web fixture transport; stdin/stdout are credential-bearing pipes."""

import asyncio
import hmac
import json
import secrets
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

from aiohttp import ClientSession, DummyCookieJar, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from employee_gateway import Binding, Configuration, EmployeeGateway, b64encode
from employee_proxy import EmployeeProxy

ORIGIN = "https://employees.example.test"


async def main():
    # Only the owning test writes this pipe; no environment credentials are read.
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=65536)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    with tempfile.TemporaryDirectory(prefix="employee-proxy-fixture-") as directory:
        raw = json.loads(await reader.readline())
        home = Path(directory)
        launch = home / "launch"
        launch.touch(mode=0o600)
        launch.write_text(raw["launch"])
        user = raw["user"]
        binding = Binding(user, raw["upstream"], home, str(launch))
        gateway = EmployeeGateway(Configuration(
            "example.test", ORIGIN, secrets.token_bytes(32), 12345, 60, 16, {user: binding},
        ))
        async def enabled(candidate):
            return candidate == user
        proxy = EmployeeProxy(gateway, enabled, recheck_seconds=0.02, check_seconds=1)
        runner = web.AppRunner(proxy.app, access_log=None, shutdown_timeout=5)
        await runner.setup()
        try:
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = runner.addresses[0][1]
            origin = f"http://127.0.0.1:{port}"
            public_origin = f"https://127.0.0.1:{port}"
            gateway.config = replace(gateway.config, public_origin=public_origin)
            while int(time.time()) <= gateway.started:
                await asyncio.sleep(0.02)
            issued = int(time.time())
            body = b64encode(json.dumps({"iss": "example.test", "sub": user,
                "iat": issued, "exp": issued + 60, "jti": secrets.token_urlsafe(18)}).encode())
            ticket = body + "." + b64encode(hmac.digest(gateway.config.secret, body.encode(), "sha256"))
            async with ClientSession(cookie_jar=DummyCookieJar()) as client:
                async with client.get(origin + "/sso", params={"token": ticket},
                    headers={}, allow_redirects=False) as response:
                    if response.status != 303:
                        raise RuntimeError("fixture handoff failed")
                    cookie = response.headers["Set-Cookie"].split(";", 1)[0]
            print(json.dumps({"origin": origin, "cookie": cookie, "publicOrigin": public_origin}), flush=True)
            await reader.read()
        finally:
            transport.close()
            await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # The parent observes exit status; never print credential-bearing state.
        raise SystemExit(1) from None
