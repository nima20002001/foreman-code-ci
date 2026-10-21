"""Collect complete license content from the owned build-time Chromium process."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from websockets.sync.client import connect


def read_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def endpoint(value):
    address = urllib.parse.urlparse(value)
    if address.scheme != "ws" or address.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError("The build browser exposed a nonlocal debugger")
    return value


def response(channel, sequence):
    while True:
        message = json.loads(channel.recv(timeout=5))
        if message.get("id") == sequence:
            if "error" in message:
                raise RuntimeError("The browser rejected credits collection")
            return message.get("result", {})


command = sys.argv[1:]
if command[-1] != "chrome://credits/":
    raise ValueError("This collector only reads Chromium's license page")
profile = Path(next(value.split("=", 1)[1] for value in command if value.startswith("--user-data-dir=")))
with tempfile.TemporaryFile() as errors:
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=errors)
    try:
        deadline = time.monotonic() + 30
        port_file = profile / "DevToolsActivePort"
        while not port_file.exists():
            if child.poll() is not None or time.monotonic() >= deadline:
                errors.seek(0)
                raise RuntimeError("Credits browser did not start: " + errors.read(4096).decode(errors="replace"))
            time.sleep(0.05)
        port = int(port_file.read_text().splitlines()[0])
        origin = "http://127.0.0.1:" + str(port)
        version = read_json(origin + "/json/version")
        html = None
        sequence = 0
        while time.monotonic() < deadline and html is None:
            pages = read_json(origin + "/json/list")
            page = next((value for value in pages if value.get("type") == "page" and value.get("url") == command[-1]), None)
            if page:
                with connect(endpoint(page["webSocketDebuggerUrl"]), open_timeout=5, max_size=32 * 1024 * 1024) as channel:
                    sequence += 1
                    channel.send(json.dumps({"id": sequence, "method": "Runtime.evaluate", "params": {
                        "expression": "document.documentElement.outerHTML", "returnByValue": True}}))
                    value = response(channel, sequence).get("result", {}).get("value", "")
                    if len(value) > 1000 and ("license" in value.lower() or "copyright" in value.lower()):
                        html = value
            if html is None:
                time.sleep(0.1)
        if html is None:
            raise RuntimeError("Chromium did not expose complete credits before its readiness deadline")
        with connect(endpoint(version["webSocketDebuggerUrl"]), open_timeout=5) as channel:
            channel.send(json.dumps({"id": 1, "method": "Browser.close"}))
        child.wait(timeout=10)
        if child.returncode != 0:
            raise RuntimeError("The credits browser did not shut down cleanly")
        sys.stdout.write(html)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
