#!/usr/bin/env python3
"""Verify checkpoint04, optionally extracting into a NEW independent directory."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

EXPECTED_SIZE = 133654
EXPECTED_SHA = "60c9fe450109e100a6483756690462894c9f7e936fb3f0c60b2b0296faf0efed"
p = argparse.ArgumentParser(description=__doc__)
p.add_argument("archive", type=Path)
p.add_argument("--extract", type=Path)
a = p.parse_args()
raw = a.archive.read_bytes()
if len(raw) != EXPECTED_SIZE or hashlib.sha256(raw).hexdigest() != EXPECTED_SHA:
    raise SystemExit("Checkpoint04 size/hash mismatch; nothing extracted")
with zipfile.ZipFile(a.archive) as z:
    if z.testzip() is not None:
        raise SystemExit("ZIP CRC failure")
    names = z.namelist()
    if len(names) != len(set(names)):
        raise SystemExit("Duplicate ZIP members")
    for name in names:
        path = PurePosixPath(name)
        mode = z.getinfo(name).external_attr >> 16
        if path.is_absolute() or ".." in path.parts or "\\" in name or (mode & 0o170000) == 0o120000:
            raise SystemExit("Unsafe ZIP member")
    manifest = json.loads(z.read("SHA256.json"))
    if set(names) != set(manifest) | {"SHA256.json"}:
        raise SystemExit("Manifest coverage mismatch")
    for name, expected in manifest.items():
        if hashlib.sha256(z.read(name)).hexdigest() != expected:
            raise SystemExit(f"Entry checksum mismatch: {name}")
    if a.extract:
        a.extract.mkdir(parents=True, exist_ok=False)
        z.extractall(a.extract)
print(json.dumps({"bytes": len(raw), "sha256": EXPECTED_SHA, "crc": "passed",
                  "manifest_entries_verified": len(manifest), "extracted": str(a.extract) if a.extract else None}, indent=2))
