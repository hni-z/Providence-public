#!/usr/bin/env python3
"""Build reproducible, state-free companion ZIP/TAR archives and an install manifest.

Usage: python3 scripts/build-companion.py /path/to/providence-companion.zip
The sibling .tar.gz and companion-manifest.json are created alongside the ZIP.
Publish both archives at /downloads/<manifest version>/ under the fixed filenames.
"""
from pathlib import Path
import argparse
import gzip
import hashlib
import io
import json
import tarfile
import zipfile


NODE_VERSION = "22.23.3"
CODEX_VERSION = "0.157.1"
# Official https://nodejs.org/dist/v22.23.3/SHASUMS256.txt, checked 2026-09-26.
# Keep the bootstrap pins in coordinator/install/install.{sh,ps1} in sync.
NODE_SHA256 = {
    "darwin_arm64": "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
    "darwin_x64": "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
    "linux_arm64": "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
    "linux_x64": "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
    "win_arm64": "33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535",
    "win_x64": "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
}


def build(output: Path, root: Path) -> dict:
    if output.suffix != ".zip":
        raise ValueError("Output must have a .zip extension")
    tar_output = output.with_suffix(".tar.gz")
    manifest_output = output.parent / "companion-manifest.json"
    for path in (output, tar_output, manifest_output):
        if path.exists():
            raise FileExistsError(f"Refusing to replace existing artifact: {path}")
    files = [root / name for name in (
        "coordinator/package.json", "coordinator/package-lock.json", "coordinator/tsconfig.json",
        "coordinator/scripts/connect.mjs", "coordinator/scripts/connect-helpers.mjs",
        "coordinator/install/prepare-codex.mjs", "coordinator/install/codex/package.json",
        "coordinator/install/codex/package-lock.json",
        "coordinator/install/background.mjs", "coordinator/install/background-runner.mjs",
        "coordinator/install/uninstall.mjs", "coordinator/install/uninstall-windows.ps1",
        "coordinator/install/keep-awake.mjs", "coordinator/install/keep-awake.d.mts", "coordinator/install/keep-awake.ps1",
    )]
    files += list((root / "coordinator/src").rglob("*.ts"))
    files += list((root / "iphone-mirroring").glob("*.mjs"))
    files += list((root / "iphone-mirroring").glob("*.mts"))
    files = [p for p in files if not p.name.endswith((".test.ts", ".test.mjs"))]
    records = []
    content_hash = hashlib.sha256()
    for path in sorted(files):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Source must contain only regular files: {path.relative_to(root)}")
        name = "providence-companion/" + path.relative_to(root).as_posix()
        data = path.read_bytes()
        content_hash.update(name.encode() + b"\0" + str(len(data)).encode() + b"\0" + data)
        records.append((name, data))
    version = content_hash.hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for name, data in records:
            entry = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100600 << 16
            archive.writestr(entry, data)
    with tar_output.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(mode="w", fileobj=compressed, format=tarfile.USTAR_FORMAT) as archive:
                for name, data in records:
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o600
                    entry.mtime = 0
                    archive.addfile(entry, io.BytesIO(data))
    archive_root = f"https://providence.hani.so/downloads/{version}/providence-companion"
    manifest = {
        "schemaVersion": 1,
        "version": version,
        "archiveZipUrl": archive_root + ".zip",
        "archiveZipSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "archiveTarGzUrl": archive_root + ".tar.gz",
        "archiveTarGzSha256": hashlib.sha256(tar_output.read_bytes()).hexdigest(),
        "nodeVersion": NODE_VERSION,
        "codexVersion": CODEX_VERSION,
        **{f"node_{platform}_sha256": digest for platform, digest in NODE_SHA256.items()},
    }
    with manifest_output.open("x") as target:
        target.write(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = build(args.output, Path(__file__).resolve().parents[1])
    print(json.dumps({"version": manifest["version"], "manifest": str(args.output.parent / "companion-manifest.json")}, indent=2))
