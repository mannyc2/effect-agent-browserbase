#!/usr/bin/env python3
"""Fetch canonical Browserbase development inputs; never edits a working package.
Python 3.12+, curl, git, tar are required. Network and install results are not
pre-asserted. --install uses the upstream's own frozen Bun/Vite+ command path.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import quote, urlsplit
import zipfile

REPOSITORIES = {
    "effect-agent": ("https://github.com/danieljvdm/effect-agent.git", "ea53ea6671a94eb44b8019e942cc2c9468786723"),
    "effect": ("https://github.com/Effect-TS/effect.git", "4a05d4914fa2327a42bd75fe77c22c188becf3b4"),
}
PACKAGES = {
    "effect": "4.0.0-rc.115", "effect-agent": "0.1.0-beta.102",
    "@effect-agent/testing": "0.1.0-beta.102", "playwright-core": "1.63.0",
    "@effect/platform-node": "4.0.0-rc.115", "@effect/platform-bun": "4.0.0-rc.115",
    "@effect/vitest": "4.0.0-rc.115", "@effect/tsgo": "0.45.0",
    "typescript": "7.0.2", "vite-plus": "0.3.2", "vitest": "4.1.11",
}

class Preparation:
    def __init__(self, root: Path):
        self.root = root
        self.logs = root / "commands"
        self.logs.mkdir(parents=True)
        self.files: dict[str, dict[str, object]] = {}
        self.count = 0
        self.env = dict(os.environ)

    def run(self, args: list[str], cwd: Path | None = None, seconds: int = 300) -> str:
        self.count += 1
        stem = self.logs / f"{self.count:03d}"
        work = cwd or self.root
        try:
            p = subprocess.run(args, cwd=work, env=self.env, capture_output=True, timeout=seconds)
            code, stdout, stderr = p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as e:
            code, stdout, stderr = 124, e.stdout or b"", (e.stderr or b"") + b"\nCommand timed out.\n"
        except OSError as e:
            code, stdout, stderr = 127, b"", str(e).encode()
        stem.with_suffix(".stdout").write_bytes(stdout)
        stem.with_suffix(".stderr").write_bytes(stderr)
        stem.with_suffix(".json").write_text(json.dumps({
            "command": args, "cwd": str(work), "exit_code": code,
            "stdout": stem.with_suffix(".stdout").name,
            "stderr": stem.with_suffix(".stderr").name,
        }, indent=2) + "\n")
        if code:
            raise RuntimeError(f"exit {code}; see {stem}.json and {stem}.stderr")
        return stdout.decode("utf-8", errors="strict")

    def fetch(self, url: str, path: Path) -> None:
        if urlsplit(url).scheme != "https":
            raise ValueError("Only HTTPS input URLs are permitted")
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + ".part")
        self.run(["curl", "--fail", "--location", "--silent", "--show-error",
                  "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
                  "--max-time", "300", "--output", str(part), url], seconds=310)
        part.replace(path)
        self.files[str(path.relative_to(self.root))] = {
            "url": url, "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "verification": "download fingerprint only until an integrity check below succeeds",
        }

    def verify_hash(self, path: Path, expected: str, algorithm: str = "sha256") -> None:
        actual = hashlib.new(algorithm, path.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"{path.name}: {algorithm} mismatch")
        self.files[str(path.relative_to(self.root))]["verification"] = f"verified {algorithm} against official metadata"

    def package(self, name: str, version: str) -> None:
        safe = name.replace("@", "").replace("/", "__") + "-" + version
        meta = self.root / "metadata" / (safe + ".json")
        self.fetch(f"https://registry.npmjs.org/{quote(name, safe='')}/{quote(version, safe='')}", meta)
        m = json.loads(meta.read_text())
        if m.get("name") != name or m.get("version") != version:
            raise ValueError(f"Unexpected registry identity for {name}@{version}")
        dist = m["dist"]
        u = urlsplit(dist["tarball"])
        if u.scheme != "https" or u.hostname != "registry.npmjs.org" or u.username or u.password:
            raise ValueError("Registry tarball was not on the permitted canonical origin")
        archive = self.root / "packages" / (safe + ".tgz")
        self.fetch(dist["tarball"], archive)
        sri = dist.get("integrity", "").split()
        selected = next((s for alg in ("sha512-", "sha256-") for s in sri if s.startswith(alg)), None)
        if selected is None:
            raise ValueError(f"No strong registry integrity value for {name}@{version}")
        algorithm, encoded = selected.split("-", 1)
        digest = base64.b64decode(encoded, validate=True).hex()
        self.verify_hash(archive, digest, algorithm)
        with tarfile.open(archive, "r:gz") as t:
            member = t.extractfile("package/package.json")
            if member is None:
                raise ValueError(f"Missing package manifest: {name}")
            identity = json.load(member)
            if (identity.get("name"), identity.get("version")) != (name, version):
                raise ValueError(f"Tarball identity mismatch: {name}")

    def source(self, name: str, url: str, revision: str) -> None:
        source = self.root / "sources" / name
        source.mkdir(parents=True)
        self.run(["git", "init", "-q", str(source)])
        self.run(["git", "remote", "add", "origin", url], source)
        self.run(["git", "-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "origin", revision], source)
        actual = self.run(["git", "rev-parse", "FETCH_HEAD"], source).strip()
        if actual != revision:
            raise ValueError("Fetched Git object is not the requested revision")
        self.run(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", revision], source)
        self.run(["git", "fsck", "--no-reflogs"], source)
        if self.run(["git", "status", "--porcelain"], source).strip():
            raise ValueError("Source checkout is not clean")
        if name == "effect-agent":
            for relative in ("AGENTS.md", "docs/TOOLCHAIN.md", "package.json", "bun.lock", "bunfig.toml"):
                src = source / relative
                if not src.is_file():
                    raise ValueError(f"Required upstream file is missing: {relative}")
                target = self.root / "inspection" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
            manifest = json.loads((source / "package.json").read_text())
            if manifest.get("packageManager") != "bun@1.4.2":
                raise ValueError("Unexpected upstream package-manager declaration")
            for key, version in {"effect": "4.0.0-rc.115", "typescript": "7.0.2", "vite-plus": "0.3.2", "vitest": "4.1.11"}.items():
                if manifest["catalog"].get(key) != version:
                    raise ValueError(f"Unexpected upstream catalog entry: {key}")

    def runtimes(self) -> tuple[Path, Path]:
        base = "https://nodejs.org/dist/v24.14.1/"
        filename = "node-v24.14.1-linux-x64.tar.xz"
        sums = self.root / "runtimes" / "NODE-SHASUMS256.txt"
        node_archive = sums.parent / filename
        self.fetch(base + "SHASUMS256.txt", sums)
        expected = next((line.split()[0] for line in sums.read_text().splitlines()
                         if len(line.split()) == 2 and line.split()[1].lstrip("*") == filename), None)
        if expected is None:
            raise ValueError("Official Node checksums did not contain the requested binary")
        self.fetch(base + filename, node_archive)
        self.verify_hash(node_archive, expected)
        release = sums.parent / "bun-release.json"
        self.fetch("https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.2", release)
        data = json.loads(release.read_text())
        if data.get("tag_name") != "bun-v1.4.2":
            raise ValueError("Unexpected Bun release")
        asset = next(a for a in data["assets"] if a["name"] == "bun-linux-x64.zip")
        digest = asset.get("digest") or ""
        if not digest.startswith("sha256-") and not digest.startswith("sha256:"):
            raise ValueError("Official Bun release asset lacks a SHA-256 digest; no unchecked binary will be executed")
        url = asset["browser_download_url"]
        if not url.startswith("https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/"):
            raise ValueError("Unexpected Bun download location")
        bun_archive = sums.parent / "bun-linux-x64.zip"
        self.fetch(url, bun_archive)
        self.verify_hash(bun_archive, digest[7:])
        runtime_root = self.root / "runtime"
        runtime_root.mkdir()
        with tarfile.open(node_archive) as t:
            t.extractall(runtime_root, filter="data")
        bun = runtime_root / "bun"
        with zipfile.ZipFile(bun_archive) as z:
            bun.write_bytes(z.read("bun-linux-x64/bun"))
        bun.chmod(0o755)
        node = runtime_root / "node-v24.14.1-linux-x64" / "bin" / "node"
        if self.run([str(node), "--version"]).strip() != "v24.14.1":
            raise ValueError("Node version mismatch")
        if self.run([str(bun), "--version"]).strip() != "1.4.2":
            raise ValueError("Bun version mismatch")
        return node, bun

    def install(self, node: Path, bun: Path) -> None:
        # Source is a clean input checkout, not an application or candidate tree.
        # Initial Bun bootstrap matches the pinned repository's CI. Further commands use vp.
        source = self.root / "sources" / "effect-agent"
        self.env["PATH"] = f"{node.parent}:{bun.parent}:" + self.env.get("PATH", "")
        self.env["BUN_INSTALL_CACHE_DIR"] = str(self.root / "bun-cache")
        self.env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
        self.env["VP_GIT_HOOKS"] = "0"
        original_lock = (source / "bun.lock").read_bytes()
        self.run([str(bun), "install", "--frozen-lockfile", "--ignore-scripts"], source, seconds=1200)
        vp = source / "node_modules" / ".bin" / "vp"
        self.run([str(vp), "env", "doctor"], source)
        self.run([str(vp), "install", "--frozen-lockfile", "--ignore-scripts"], source, seconds=1200)
        if (source / "bun.lock").read_bytes() != original_lock:
            raise ValueError("Frozen install unexpectedly changed upstream bun.lock")
        guidance = source / "node_modules" / "effect" / "AGENTS.md"
        shutil.copy2(guidance, self.root / "inspection" / "effect-AGENTS.md")
        self.run([str(vp), "run", "patch:tsgo"], source)
        consumer = self.root / "public-consumer"
        consumer.mkdir()
        selected = {n: PACKAGES[n] for n in ("effect", "effect-agent", "@effect-agent/testing", "playwright-core")}
        (consumer / "package.json").write_text(json.dumps({
            "name": "browserbase-input-import-probe", "private": True, "type": "module",
            "dependencies": selected,
        }, indent=2) + "\n")
        (consumer / "imports.mjs").write_text('''import { Effect } from "effect";
import { AgentRuntime } from "effect-agent";
import { ScriptedModel } from "@effect-agent/testing/scripted-model";
import { Toolkit } from "effect/unstable/ai";
import { chromium } from "playwright-core";
if (typeof AgentRuntime.run !== "function" || typeof ScriptedModel.layer !== "function" ||
    typeof Toolkit.make !== "function" || typeof chromium.connectOverCDP !== "function") {
  throw new Error("Required public export is missing");
}
await Effect.runPromise(Effect.void);
console.log("Real public package imports passed; no browser or interpreter turns executed.");
''')
        self.run([str(bun), "install", "--ignore-scripts"], consumer, seconds=600)
        self.run([str(bun), "install", "--frozen-lockfile", "--ignore-scripts"], consumer, seconds=600)
        self.run([str(node), "imports.mjs"], consumer)
        self.run([str(bun), "imports.mjs"], consumer)

    def write_manifest(self, status: str, error: str | None) -> None:
        (self.root / "INPUTS.json").write_text(json.dumps({
            "status": status, "error": error, "files": self.files,
            "source_pins": REPOSITORIES, "seed_packages": PACKAGES,
            "transitive_resolution": "Actual upstream frozen bun.lock plus generated public-consumer bun.lock when --install succeeds; not a fabricated resolver",
            "acceptance": "Input preparation only. No candidate patch, native browser, hosted session, publication, or deployment is performed.",
        }, indent=2) + "\n")

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="NEW isolated staging directory; existing directories are refused")
    parser.add_argument("--install", action="store_true", help="Restore actual locked upstream/toolchain transitive inputs and test real public imports")
    args = parser.parse_args()
    root = args.out.resolve()
    if root.exists():
        parser.error("--out must not exist; this script never resets or overwrites a workspace")
    root.mkdir(parents=True)
    prep = Preparation(root)
    try:
        for name, (url, revision) in REPOSITORIES.items():
            prep.source(name, url, revision)
        for name, version in PACKAGES.items():
            prep.package(name, version)
        node, bun = prep.runtimes()
        if args.install:
            prep.install(node, bun)
        prep.write_manifest("completed", None)
        print(root / "INPUTS.json")
        return 0
    except Exception as e:
        prep.write_manifest("incomplete", str(e))
        print(f"Input preparation stopped: {e}. Partial inputs and logs remain at {root}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
