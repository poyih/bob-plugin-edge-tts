"""从 make / Python CLI 边界验证更新登记，不访问网络。"""
import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class AppcastTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="edge-appcast-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "dist").mkdir()
        self.info = {
            "identifier": "com.poyih.bob.plugin.edge.tts", "version": "1.2.0",
            "category": "tts", "minBobVersion": "1.8.0",
        }
        (self.root / "src/info.json").write_text(json.dumps(self.info))
        (self.root / "appcast.json").write_text(json.dumps({
            "identifier": self.info["identifier"], "versions": [],
        }))
        shutil.copyfile(ROOT / "Makefile", self.root / "Makefile")
        shutil.copyfile(ROOT / "scripts/update_appcast.py", self.root / "scripts/update_appcast.py")
        self.bundle = self.write_bundle(self.info)

    def write_bundle(self, info, name="bob-plugin-edge-tts-1.2.0.bobplugin"):
        path = self.root / "dist" / name
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("info.json", json.dumps(info))
            archive.writestr("main.js", "exports.tts = function () {};\n")
        return path

    def run_cli(self, *args):
        return subprocess.run(
            ["python3", "scripts/update_appcast.py", "--bundle", str(self.bundle), *args],
            cwd=self.root, text=True, capture_output=True,
        )

    def entry(self):
        return json.loads((self.root / "appcast.json").read_text())["versions"][0]

    def test_make_preserves_description_as_literal_text(self):
        shell_marker = self.root / "shell-executed"
        make_marker = self.root / "make-executed"
        description = (f'修复 "带空格的 音色" 与 `touch {shell_marker}` '
                       f'$(shell touch {make_marker}) $HOME \\字面量')
        result = subprocess.run(
            ["make", "appcast", "DESC=" + description], cwd=self.root,
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.entry()["desc"], description)
        self.assertFalse(shell_marker.exists(), "更新说明不能作为 Shell 命令执行")
        self.assertFalse(make_marker.exists(), "更新说明不能作为 Make 表达式执行")

    def test_older_bundle_is_registered_after_main_version_changes(self):
        newer = dict(self.info, version="1.3.0", minBobVersion="2.0.0")
        (self.root / "src/info.json").write_text(json.dumps(newer))
        result = self.run_cli("--desc", "发布 1.2.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entry()["version"], "1.2.0")
        self.assertEqual(self.entry()["minBobVersion"], "1.8.0")
        self.assertEqual(self.entry()["sha256"], hashlib.sha256(self.bundle.read_bytes()).hexdigest())
        self.assertIn("/download/v1.2.0/", self.entry()["url"])

    def assert_rejected_without_changing_appcast(self, *args):
        before = (self.root / "appcast.json").read_bytes()
        result = self.run_cli(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "appcast.json").read_bytes(), before)

    def test_filename_must_match_embedded_version(self):
        self.write_bundle(dict(self.info, version="1.0.0"))
        self.assert_rejected_without_changing_appcast()

    def test_tag_must_match_embedded_version(self):
        self.assert_rejected_without_changing_appcast("--tag", "v1.3.0")

    def test_identifier_must_match_existing_appcast(self):
        self.write_bundle(dict(self.info, identifier="com.other.plugin"))
        self.assert_rejected_without_changing_appcast()

    def test_corrupt_archive_is_rejected(self):
        self.bundle.write_bytes(b"not a plugin zip")
        self.assert_rejected_without_changing_appcast()

    def test_same_version_cannot_replace_registered_audio_plugin(self):
        self.assertEqual(self.run_cli().returncode, 0)
        with zipfile.ZipFile(self.bundle, "w") as archive:
            archive.writestr("info.json", json.dumps(self.info))
            archive.writestr("main.js", "different code")
        self.assert_rejected_without_changing_appcast()

    def test_rerun_keeps_original_timestamp_and_file_bytes(self):
        self.assertEqual(self.run_cli("--desc", "同一份说明").returncode, 0)
        before = (self.root / "appcast.json").read_bytes()
        result = self.run_cli("--desc", "同一份说明")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "appcast.json").read_bytes(), before)

    def test_description_file_preserves_quotes_and_newlines(self):
        text = '修复 "音色" 与 `voiceMap`\n\n第二段说明 $HOME'
        path = self.root / "notes.txt"
        path.write_text(text + "\n", encoding="utf-8")
        result = self.run_cli("--desc-file", str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entry()["desc"], text)


if __name__ == "__main__":
    unittest.main()
