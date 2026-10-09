#!/usr/bin/env python3
"""Check tracked showcase files without printing matched private values."""
from pathlib import Path
import argparse
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description="Check source files for private data and internal development documents.")
parser.add_argument("--source-dir", type=Path, help="Scan every file in a clean source export without requiring Git.")
args = parser.parse_args()
root = (args.source_dir or Path(__file__).resolve().parents[1]).resolve()
if not root.is_dir():
    parser.error("source directory does not exist")
if args.source_dir:
    files = [str(path.relative_to(root)) for path in root.rglob("*") if path.is_file() or path.is_symlink()]
else:
    files = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
patterns = {
    "personal home directory": re.compile(r"/(?:Users|home)/(?!(?:developer|example|runner)(?:/|$|[\s`\"')]))[^/\s`\"')]+"),
    "personal Windows home directory": re.compile(r"\b[A-Z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:developer|example|runner)(?:[\\/]|$|[\s`\"')]))[^\\/\s`\"')]+", re.IGNORECASE),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "provider key": re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}"),
    "Apple signing team": re.compile(r'DEVELOPMENT_TEAM\s*=\s*"?[A-Z0-9]{10}\b'),
}
email = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
allowed_domains = {"example.com", "example.org", "example.net", "example.co.uk", "example-mail.com", "example-domain.com", "providence.hani.so"}
problems = []
for name in files:
    if not name:
        continue
    path = root / name
    if path.is_symlink():
        problems.append((name, 0, "source symlink requires review"))
        continue
    if not path.is_file():
        continue
    if re.search(r"(?:^|/)(?:AGENTS\.md|[^/]*(?:_PROMPT|_HANDOFF|_RECEIPT|_PLAN)\.md)$", name, re.IGNORECASE):
        problems.append((name, 0, "internal development document"))
    if any(part in {".git", ".providence", ".codex", "xcuserdata"} for part in Path(name).parts) or name.endswith((".p12", ".p8", ".mobileprovision", ".sqlite", ".jsonl", ".key", ".pem")) or (path.name.startswith(".env") and not path.name.endswith(".example")):
        problems.append((name, 0, "private runtime or credential file"))
    try:
        text = path.read_text()
    except UnicodeError:
        continue
    except OSError:
        problems.append((name, 0, "unreadable source file"))
        continue
    for number, line in enumerate(text.splitlines(), 1):
        # The checker contains pattern definitions, not actual credentials.
        if name == "scripts/check-showcase-privacy.py":
            continue
        for label, pattern in patterns.items():
            if pattern.search(line):
                problems.append((name, number, label))
        for match in email.finditer(line):
            domain = match.group(1).lower()
            if domain not in allowed_domains and not domain.endswith(".example"):
                problems.append((name, number, "non-example email address"))
for name, line, label in problems:
    print(f"{name}:{line}: {label}")
if problems:
    sys.exit(1)
print("Showcase privacy checks passed for source files. Review images and history separately.")
