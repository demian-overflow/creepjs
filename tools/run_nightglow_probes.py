#!/usr/bin/env python3
"""Run docs/tests/nightglow_shim.html against a Nightglow WebDriver endpoint
and report leaks. Defaults assume a port-forward to the cluster-side pod:

    kubectl port-forward -n orderout pod/$(kubectl get pod -n orderout \
        -l app=nightglow -o jsonpath='{.items[0].metadata.name}') 7000:7000

Then either serve docs/ over HTTP somewhere (so the test page can be reached
from the browser), or pass --inline to read the html/js locally and pipe them
in via a data: URL.

Usage:
    python tools/run_nightglow_probes.py [--driver URL] [--inline] [--target URL]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from urllib.request import Request, urlopen


def call(driver, method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    r = Request(
        f"{driver}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def aexec(driver, sid, script, timeout=20):
    return call(
        driver,
        "POST",
        f"/session/{sid}/execute/async",
        {"script": script, "args": []},
        timeout=timeout + 5,
    )["value"]


def build_inline_url(html_path: str, js_path: str) -> str:
    """Return a single data: URL with the JS spliced into the HTML so we
    don't have to host the docs/ tree."""
    with open(html_path) as f:
        html = f.read()
    with open(js_path) as f:
        js = f.read()
    # Replace the external script tag with an inline copy.
    inline = "<script>\n" + js + "\n</script>"
    if "<script src=\"nightglow_shim.js\"></script>" in html:
        html = html.replace(
            '<script src="nightglow_shim.js"></script>', inline
        )
    else:
        html = html.replace("</body>", inline + "\n</body>")
    return "data:text/html;base64," + base64.b64encode(html.encode()).decode()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)

    p = argparse.ArgumentParser()
    p.add_argument("--driver", default="http://127.0.0.1:7000",
                   help="WebDriver base URL (default: %(default)s)")
    p.add_argument("--inline", action="store_true",
                   help="Splice docs/tests/nightglow_shim.{html,js} into a data: URL "
                        "instead of relying on a hosted page.")
    p.add_argument("--target",
                   help="Override URL to drive (e.g., http://localhost:8000/tests/nightglow_shim.html)")
    p.add_argument("--wait", type=float, default=8.0,
                   help="Seconds to let probes run before reading results")
    p.add_argument("--json", action="store_true",
                   help="Output JSON only (no human summary)")
    args = p.parse_args()

    if args.target:
        url = args.target
    elif args.inline:
        url = build_inline_url(
            os.path.join(repo, "docs", "tests", "nightglow_shim.html"),
            os.path.join(repo, "docs", "tests", "nightglow_shim.js"),
        )
    else:
        url = "http://127.0.0.1:8000/tests/nightglow_shim.html"

    sid = call(args.driver, "POST", "/session",
               {"capabilities": {"alwaysMatch": {"browserName": "servo"}}}
               )["value"]["sessionId"]
    try:
        call(args.driver, "POST", f"/session/{sid}/window/rect",
             {"x": 0, "y": 0, "width": 1280, "height": 800})
        call(args.driver, "POST", f"/session/{sid}/url", {"url": url}, timeout=60)
        time.sleep(args.wait)
        results = call(args.driver, "POST", f"/session/{sid}/execute/sync",
                       {"script": "return window.__nightglowShimProbes || null;",
                        "args": []})["value"]
    finally:
        try:
            call(args.driver, "DELETE", f"/session/{sid}")
        except Exception:
            pass

    if results is None:
        print("ERROR: probes did not surface __nightglowShimProbes — page likely "
              "didn't load or JS errored before recording results.", file=sys.stderr)
        sys.exit(2)

    if args.json:
        print(json.dumps(results, indent=2))
        return

    leaks = [r for r in results if r.get("verdict") == "leak"]
    oks = [r for r in results if r.get("verdict") == "ok"]
    unk = [r for r in results if r.get("verdict") == "unknown"]
    print(f"== {len(results)} probes: {len(oks)} ok, {len(leaks)} leak, {len(unk)} unknown ==\n")
    for r in results:
        v = r.get("verdict", "?")
        mark = {"ok": "✓", "leak": "✗", "unknown": "?"}.get(v, "?")
        print(f"  {mark} [{v:7}] {r.get('name','')}")
        if v != "ok":
            print(f"        actual:   {json.dumps(r.get('actual'))}")
            print(f"        expected: {r.get('expected')}")
            note = r.get("note")
            if note:
                print(f"        note:     {note}")
    if leaks:
        sys.exit(1)


if __name__ == "__main__":
    main()
