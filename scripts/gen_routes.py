#!/usr/bin/env python3
"""Regenerates routes.txt, the API path templates in Emby's official spelling.

Emby matches paths case-insensitively and many clients send them lowercased, but an
upstream behind a stricter proxy may accept only the official spelling. The plugin
rewrites forwarded paths along these templates.

The templates come from the OpenAPI document in the official SDK. Run again when Emby
releases a version with new endpoints:

    python3 scripts/gen_routes.py
"""
import json
import pathlib
import urllib.request

SPEC = "https://raw.githubusercontent.com/MediaBrowser/Emby.SDK/master/Resources/OpenApi/openapi_v3.json"

with urllib.request.urlopen(SPEC) as r:
    spec = json.load(r)
paths = sorted(spec["paths"])
out = pathlib.Path(__file__).resolve().parent.parent / "routes.txt"
out.write_text(
    f"# Emby {spec['info']['version']} API path templates from the official SDK's"
    " Resources/OpenApi/openapi_v3.json (scripts/gen_routes.py)\n" + "\n".join(paths) + "\n"
)
print(f"{len(paths)} templates -> {out}")
