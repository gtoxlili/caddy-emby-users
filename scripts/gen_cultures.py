#!/usr/bin/env python3
"""Regenerates cultures.json, the plugin's answer to /Localization/Cultures.

Emby builds this list from the Library of Congress ISO 639-2 table: one entry per
language that also has an ISO 639-1 code, named in English, with the bibliographic
three-letter code first. Clients fill their language pickers from it, and the plugin
answers with it when the upstream refuses the request. Run with:

    python3 scripts/gen_cultures.py
"""
import json
import pathlib
import urllib.request

TABLE = "https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt"

# loc.gov refuses urllib's default User-Agent.
with urllib.request.urlopen(urllib.request.Request(TABLE, headers={"User-Agent": "curl/8"})) as r:
    lines = r.read().decode("utf-8-sig").splitlines()
cultures = []
for line in lines:
    bib, term, two, english, _ = line.split("|")
    if not two:
        continue
    cultures.append({
        "Name": english,
        "DisplayName": english,
        "TwoLetterISOLanguageName": two,
        "ThreeLetterISOLanguageName": bib,
        "ThreeLetterISOLanguageNames": [bib, term] if term else [bib],
    })
out = pathlib.Path(__file__).resolve().parent.parent / "cultures.json"
out.write_text("[\n" + ",\n".join(json.dumps(c, ensure_ascii=False) for c in cultures) + "\n]\n")
print(f"{len(cultures)} cultures -> {out}")
