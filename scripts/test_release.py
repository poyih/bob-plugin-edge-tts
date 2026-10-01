"""在临时 Git 仓库中执行实际工作流步骤，GitHub CLI 仅在边界替换。"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ["FAKE_GH_DIR"])
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
def option(name):
    return args[args.index(name) + 1]
asset = root / "bob-plugin-edge-tts-1.2.0.bobplugin"
if args[:2] == ["release", "view"]:
    if not (root / "exists").exists(): sys.exit(1)
    print(json.dumps({"assets": [{"name": asset.name}] if asset.exists() else []}))
elif args[:2] == ["release", "download"]:
    directory = Path(option("--dir")); directory.mkdir(exist_ok=True)
    shutil.copyfile(asset, directory / asset.name)
elif args[:2] in (["release", "upload"], ["release", "create"]):
    source = Path(next(value for value in args[3:] if value.endswith(".bobplugin")))
    if asset.exists() and "--clobber" not in args: sys.exit(1)
    shutil.copyfile(source, asset)
    (root / "exists").touch()
elif args[:2] == ["pr", "create"]:
    print("https://example.invalid/pull/1")
else:
    raise SystemExit("unexpected gh invocation: " + repr(args))
'''


def workflow_step(name):
    lines = (ROOT / ".github/workflows/release.yml").read_text().splitlines()
    start = lines.index("      - name: " + name)
    script = []
    collecting = False
    for line in lines[start + 1:]:
        if line.startswith("      - "):
            break
        if line == "        run: |":
            collecting = True
        elif collecting and line.startswith("          "):
            script.append(line[10:])
        elif collecting and not line.strip():
            script.append("")
    if not script:
        raise AssertionError("工作流步骤没有可执行脚本：" + name)
    return "\n".join(script)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="edge-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.remote = self.base / "origin.git"
        self.root = self.base / "workspace"
        self.root.mkdir()
        subprocess.run(["git", "init", "--bare", str(self.remote)], check=True, capture_output=True)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.base / "no-hooks"))
        self.git("remote", "add", "origin", str(self.remote))
        (self.root / "src").mkdir()
        self.info = {"identifier": "com.poyih.bob.plugin.edge.tts", "version": "1.2.0",
                     "minBobVersion": "1.8.0", "category": "tts"}
        (self.root / "src/info.json").write_text(json.dumps(self.info))
        (self.root / "src/main.js").write_text("tagged code\n")
        (self.root / "appcast.json").write_text(json.dumps({
            "identifier": self.info["identifier"], "versions": [],
        }))
        (self.root / "Makefile").write_text("pack:\n\t@python3 pack_fixture.py\n")
        (self.root / "pack_fixture.py").write_text(
            "import json, zipfile\nfrom pathlib import Path\n"
            "version=json.loads(Path('src/info.json').read_text())['version']\n"
            "Path('dist').mkdir(exist_ok=True)\n"
            "with zipfile.ZipFile('dist/bob-plugin-edge-tts-'+version+'.bobplugin','w') as z:\n"
            "    for p in sorted(Path('src').iterdir()): z.write(p,p.name)\n"
        )
        self.git("add", ".")
        self.git("commit", "-m", "tagged source")
        self.tag_commit = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("tag", "-a", "v1.2.0", "-m", "发布说明")
        (self.root / "src/main.js").write_text("newer main code\n")
        (self.root / "scripts").mkdir()
        for name in ("update_appcast.py", "check_release_asset.py"):
            shutil.copyfile(ROOT / "scripts" / name, self.root / "scripts" / name)
        self.git("add", ".")
        self.git("commit", "-m", "main moved on")
        self.git("push", "origin", "main", "--tags")
        self.runner = self.base / "runner"
        self.runner.mkdir()
        self.outputs = self.base / "outputs"
        self.env = dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF_NAME="main",
                        GITHUB_WORKSPACE=str(self.root), GITHUB_REPOSITORY="example/edge-tts",
                        RUNNER_TEMP=str(self.runner), GITHUB_OUTPUT=str(self.outputs), NOTES="")
        self.gh_dir = self.base / "github"
        self.gh_dir.mkdir()
        self.bin_dir = self.base / "bin"
        self.bin_dir.mkdir()
        (self.bin_dir / "gh").write_text(FAKE_GH)
        (self.bin_dir / "gh").chmod(0o755)
        self.env.update(FAKE_GH_DIR=str(self.gh_dir), PATH=str(self.bin_dir) + os.pathsep + self.env["PATH"])

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, text=True, capture_output=True)

    def run_step(self, name, **extra):
        return subprocess.run(["bash", "-e", "-o", "pipefail", "-c", workflow_step(name)],
                              cwd=self.root, env=dict(self.env, **extra), text=True, capture_output=True)

    def test_manual_release_builds_existing_tag_commit(self):
        result = self.run_step("确定标签")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.tag_commit)
        self.assertEqual((self.root / "src/main.js").read_text(), "tagged code\n")

    def write_bundle(self, directory, code="tagged code\n", date=(2000, 1, 1, 0, 0, 0)):
        directory.mkdir(exist_ok=True)
        path = directory / "bob-plugin-edge-tts-1.2.0.bobplugin"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(zipfile.ZipInfo("info.json", date), json.dumps(self.info))
            archive.writestr(zipfile.ZipInfo("main.js", date), code)
        return path

    def save_tools(self):
        result = self.run_step("保存发布工具")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def gh_calls(self):
        return [json.loads(line) for line in (self.gh_dir / "calls.jsonl").read_text().splitlines()]

    def test_existing_identical_asset_is_reused_without_upload(self):
        self.save_tools()
        candidate = self.write_bundle(self.runner, date=(2026, 1, 1, 0, 0, 0))
        self.write_bundle(self.root / "dist", date=(2026, 1, 1, 0, 0, 0))
        existing = self.write_bundle(self.gh_dir)
        (self.gh_dir / "exists").touch()
        before = existing.read_bytes()
        (self.runner / "edge-release-notes.md").write_text("发布说明\n")
        result = self.run_step("创建 GitHub Release 并上传插件包", TAG="v1.2.0", BUNDLE=str(candidate))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(existing.read_bytes(), before)
        self.assertEqual(candidate.read_bytes(), before, "appcast 必须使用实际已发布资产的字节")
        self.assertFalse(any(call[:2] == ["release", "upload"] for call in self.gh_calls()))

    def test_appcast_uses_saved_bundle_after_main_version_changes(self):
        self.save_tools()
        (self.root / "src/info.json").write_text(json.dumps(dict(self.info, version="1.3.0")))
        self.git("add", ".")
        self.git("commit", "-m", "next version on main")
        self.git("push", "origin", "main")
        bundle = self.write_bundle(self.runner)
        description = '修复 "音色" 与 `voiceMap` $HOME'
        (self.runner / "edge-release-subject.txt").write_text(description + "\n")
        result = self.run_step("登记 appcast 并推回 main", TAG="v1.2.0", BUNDLE=str(bundle), SUBJECT=description)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads((self.root / "src/info.json").read_text())["version"], "1.3.0")
        entry = json.loads(self.git("show", "origin/main:appcast.json").stdout)["versions"][0]
        self.assertEqual(entry["version"], "1.2.0")
        self.assertEqual(entry["desc"], description)

    def test_existing_different_asset_is_not_overwritten(self):
        self.save_tools()
        bundle = self.write_bundle(self.runner)
        existing = self.write_bundle(self.gh_dir, code="previously published different code\n")
        (self.gh_dir / "exists").touch()
        before = existing.read_bytes()
        result = self.run_step("创建 GitHub Release 并上传插件包", TAG="v1.2.0", BUNDLE=str(bundle))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(existing.read_bytes(), before)
        self.assertFalse(any(call[:2] == ["release", "upload"] for call in self.gh_calls()))

    def test_tag_event_builds_tag_even_when_main_has_new_version(self):
        (self.root / "src/info.json").write_text(json.dumps(dict(self.info, version="1.3.0")))
        self.git("add", ".")
        self.git("commit", "-m", "next version")
        self.git("push", "origin", "main")
        result = self.run_step("确定标签", GITHUB_EVENT_NAME="push", GITHUB_REF_NAME="v1.2.0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.tag_commit)

    def test_tag_description_preserves_first_line_and_complete_notes(self):
        subject = '修复 "音色" 与 `voiceMap` $HOME'
        notes = subject + "\n第二行也是正文\n\n完整说明"
        self.git("tag", "-f", "-a", "v1.2.0", "-m", notes, self.tag_commit)
        result = self.run_step("读取更新说明", TAG="v1.2.0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.runner / "edge-release-subject.txt").read_text().rstrip("\n"), subject)
        self.assertEqual((self.runner / "edge-release-notes.md").read_text().rstrip("\n"), notes)

    def test_full_workflow_builds_publishes_and_registers_tagged_source(self):
        for step in ("保存发布工具", "确定标签", "打包", "读取更新说明"):
            result = self.run_step(step, TAG="v1.2.0")
            self.assertEqual(result.returncode, 0, step + "\n" + result.stdout + result.stderr)
        bundle = self.runner / "bob-plugin-edge-tts-1.2.0.bobplugin"
        for step in ("创建 GitHub Release 并上传插件包", "登记 appcast 并推回 main"):
            result = self.run_step(step, TAG="v1.2.0", BUNDLE=str(bundle))
            self.assertEqual(result.returncode, 0, step + "\n" + result.stdout + result.stderr)
        with zipfile.ZipFile(self.gh_dir / bundle.name) as archive:
            self.assertEqual(archive.read("main.js"), b"tagged code\n")
        self.assertEqual((self.root / "src/main.js").read_text(), "newer main code\n")
        entry = json.loads(self.git("show", "origin/main:appcast.json").stdout)["versions"][0]
        self.assertEqual(entry["version"], "1.2.0")
        self.assertEqual(entry["desc"], "发布说明")
        self.assertTrue(any(call[:2] == ["release", "create"] and "--verify-tag" in call
                            for call in self.gh_calls()))


if __name__ == "__main__":
    unittest.main()
