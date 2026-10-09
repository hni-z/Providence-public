#!/usr/bin/env python3
"""Privacy checks use source-relative paths and never print matched secrets."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECKER = Path(__file__).with_name("check-showcase-privacy.py")


class SourcePrivacyTests(unittest.TestCase):
    def scan(self, root):
        return subprocess.run([sys.executable, str(CHECKER), "--source-dir", str(root)], capture_output=True, text=True)

    def test_private_parent_is_not_part_of_the_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / ".codex" / "worktrees" / "example"
            root.mkdir(parents=True)
            (root / "README.md").write_text("Example public source.\n")
            self.assertEqual(self.scan(root).returncode, 0)

    def test_private_directory_inside_source_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".codex").mkdir()
            (root / ".codex" / "config.json").write_text("{}\n")
            result = self.scan(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn(".codex/config.json:0: private runtime or credential file", result.stdout)

    def test_provider_key_is_detected_without_disclosure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic = "sk-" + "x" * 30
            (root / "example.txt").write_text(synthetic)
            result = self.scan(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("provider key", result.stdout)
            self.assertNotIn(synthetic, result.stdout + result.stderr)

    def test_windows_home_paths_are_detected_without_disclosure(self):
        for separator in ("\\", "\\\\", "/"):
            with self.subTest(separator=separator), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                profile = "private" + "-profile"
                personal_path = separator.join(("C:", "Users", profile, "Documents"))
                (root / "README.md").write_text(personal_path)
                result = self.scan(root)
                self.assertEqual(result.returncode, 1)
                self.assertIn("personal Windows home directory", result.stdout)
                self.assertNotIn(profile, result.stdout + result.stderr)

    def test_example_windows_paths_are_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            example = "\\".join(("C:", "Users", "example", "Documents"))
            (root / "README.md").write_text(example)
            self.assertEqual(self.scan(root).returncode, 0)

    def test_example_prefix_does_not_exempt_a_personal_profile(self):
        profile = "example" + "-private"
        paths = ["/".join(("", "Users", profile, "Documents")), "\\".join(("C:", "Users", profile, "Documents"))]
        for personal_path in paths:
            with self.subTest(path=personal_path), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "README.md").write_text(personal_path)
                result = self.scan(root)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn(profile, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
