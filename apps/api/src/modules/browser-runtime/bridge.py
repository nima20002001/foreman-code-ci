"""Fixed Browser Use/Harness action bridge. No autonomous Agent, CLI daemon, or arbitrary Python input."""
import json
import os
import sys
from pathlib import Path
from importlib.metadata import version

if version("browser-use") != "0.13.11" or version("browser-harness") != "0.1.13":
    raise RuntimeError("Browser runtime package versions do not match this bridge")

workspace = Path(os.environ["BH_AGENT_WORKSPACE"])
if not workspace.is_dir() or workspace.is_symlink() or any(workspace.iterdir()):
    raise RuntimeError("Harness requires the release-owned empty workspace")

os.environ.pop("BH_DEBUG_CLICKS", None)
os.environ.pop("BH_DOMAIN_SKILLS", None)
from browser_harness import helpers


def emit(value):
    line = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    if len(line) > 524288:
        raise ValueError("Bridge message is too large")
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def receive():
    line = sys.stdin.readline(524290)
    if not line or len(line) > 524288 or not line.endswith("\n"):
        raise ValueError("Invalid bridge input")
    return json.loads(line)


def checked_cdp(method, session_id=None, _response_timeout=None, **params):
    if session_id is not None:
        raise ValueError("The broker owns target/session routing")
    if method not in {"Page.navigate", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"}:
        raise ValueError("Unsupported structured browser dispatch")
    emit({"kind": "dispatch", "method": method, "params": params})
    response = receive()
    if response.get("kind") != "result" or not response.get("ok"):
        raise RuntimeError("Browser dispatch was fenced or failed")
    return response.get("value", {})


def deny_unscoped(*args, **kwargs):
    raise RuntimeError("Unscoped Harness transport is unavailable")


helpers.cdp = checked_cdp
helpers._send = deny_unscoped


def perform(action):
    kind = action["kind"]
    if kind == "navigate":
        helpers.goto_url(action["url"])
    elif kind == "click":
        helpers.click_at_xy(action["x"], action["y"], button=action.get("button", "left"))
    elif kind == "type":
        helpers.type_text(action["text"])
    elif kind == "key":
        helpers.press_key(action["key"], modifiers=action.get("modifiers", 0))
    elif kind == "scroll":
        helpers.scroll(action["x"], action["y"], dy=action["deltaY"], dx=action["deltaX"])
    else:
        raise ValueError("Unsupported structured browser action")


try:
    perform(receive())
    emit({"kind": "complete"})
except Exception:
    # Input/URLs/page state and native errors may contain secrets. Return only a safe failure marker.
    emit({"kind": "failed"})
    sys.exit(1)
