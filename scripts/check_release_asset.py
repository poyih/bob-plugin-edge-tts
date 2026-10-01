#!/usr/bin/env python3
"""发布插件包：已有同版本资产只核对并复用，内容不同则失败，绝不覆盖。"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from update_appcast import read_bundle_info


def contents(path: Path) -> dict:
    # 旧的 zip 打包会写入文件时间与目录记录；判断代码一致性时只比较文件名和实际内容。
    with zipfile.ZipFile(path) as archive:
        return {entry.filename: archive.read(entry) for entry in archive.infolist() if not entry.is_dir()}


def gh(*args, check=True):
    result = subprocess.run(["gh", *args], text=True, capture_output=True)
    if check and result.returncode:
        raise ValueError(result.stderr.strip() or f"gh {args[0]} {args[1]} 失败")
    return result


def publish(bundle: Path, tag: str, repo: str, notes_file: Path) -> None:
    read_bundle_info(bundle, tag)
    release = gh("release", "view", tag, "--repo", repo, "--json", "assets", check=False)
    if release.returncode == 0:
        assets = json.loads(release.stdout).get("assets", [])
        if any(asset.get("name") == bundle.name for asset in assets):
            with tempfile.TemporaryDirectory(prefix="edge-existing-asset-") as directory:
                gh("release", "download", tag, "--repo", repo, "--pattern", bundle.name,
                   "--dir", directory)
                existing = Path(directory) / bundle.name
                read_bundle_info(existing, tag)
                if contents(existing) != contents(bundle):
                    raise ValueError(f"{tag} 已发布不同内容的插件包，请发布新版本；已有资产未改动")
                # 后续 appcast 必须使用线上资产的确切字节和 sha256，包括旧 zip 的时间信息。
                shutil.copyfile(existing, bundle)
            print(f"{tag} 已有相同内容的资产，复用原包")
        else:
            gh("release", "upload", tag, str(bundle), "--repo", repo)
            print(f"{tag} 已上传缺少的插件包")
    else:
        gh("release", "create", tag, str(bundle), "--repo", repo, "--verify-tag",
           "--title", f"Microsoft Edge 语音合成 {tag}", "--notes-file", str(notes_file))
        print(f"{tag} 已创建 Release 并上传插件包")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--notes-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        publish(args.bundle, args.tag, args.repo, args.notes_file)
    except (OSError, ValueError) as err:
        print(f"release FAIL  {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
