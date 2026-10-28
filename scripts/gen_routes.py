#!/usr/bin/env python3
"""Regenerates routes.txt, the API path templates and their query parameters in
Emby's official spelling.

Emby matches paths and query parameter names case-insensitively and many clients send
them lowercased, but an upstream behind a stricter proxy may accept only the official
spelling. The plugin rewrites forwarded paths along these templates, and the names of
the query parameters each template documents.

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
lines = []
for path in sorted(spec["paths"]):
    names = {
        p["name"]
        for op in spec["paths"][path].values()
        if isinstance(op, dict)
        for p in op.get("parameters", [])
        if p.get("in") == "query"
    }
    lines.append(" ".join([path, *sorted(names, key=str.lower)]))
out = pathlib.Path(__file__).resolve().parent.parent / "routes.txt"
out.write_text(
    f"# Emby {spec['info']['version']} API path templates, each followed by its query parameters,"
    " from the official SDK's Resources/OpenApi/openapi_v3.json (scripts/gen_routes.py)\n"
    + "\n".join(lines)
    + "\n"
)
print(f"{len(lines)} templates -> {out}")
