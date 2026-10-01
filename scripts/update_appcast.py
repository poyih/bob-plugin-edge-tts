#!/usr/bin/env python3
"""把已上传的 .bobplugin 登记到 appcast.json。

版本、identifier 和 minBobVersion 均取自包内 info.json，不依赖当前分支版本。
make appcast DESC="更新说明" 通过环境变量传递说明，也可以使用 --desc-file。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPO = "poyih/bob-plugin-edge-tts"
BUNDLE_NAME = "bob-plugin-edge-tts"
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")


def version_key(version: str) -> tuple:
    return tuple(int(part) if part.isdigit() else -1 for part in version.split("."))


def read_bundle_info(bundle: Path, tag: str = "") -> dict:
    """读取并校验实际分发的包，避免用文件名或当前源码猜测元信息。"""
    if not bundle.is_file():
        raise ValueError(f"找不到包：{bundle}，请先 make pack")
    try:
        with zipfile.ZipFile(bundle) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ValueError("插件包内有重复文件名")
            info = json.loads(archive.read("info.json").decode("utf-8"))
    except (zipfile.BadZipFile, KeyError, UnicodeError, json.JSONDecodeError) as err:
        raise ValueError(f"无法读取包内 info.json：{err}") from err
    if not isinstance(info, dict):
        raise ValueError("包内 info.json 必须是对象")
    for field in ("version", "minBobVersion"):
        if not isinstance(info.get(field), str) or not VERSION_RE.fullmatch(info[field]):
            raise ValueError(f"包内 {field} 必须是 x.y.z 格式")
    if not isinstance(info.get("identifier"), str) or not re.fullmatch(r"[a-z0-9.]+", info["identifier"]):
        raise ValueError("包内 identifier 无效")
    expected_name = f"{BUNDLE_NAME}-{info['version']}.bobplugin"
    if bundle.name != expected_name:
        raise ValueError(f"包名 {bundle.name} 与包内版本不一致，应为 {expected_name}")
    if tag and tag != f"v{info['version']}":
        raise ValueError(f"标签 {tag} 与包内版本 {info['version']} 不一致")
    return info


def update_appcast(bundle: Path, appcast_path: Path, desc: str = "", repo: str = DEFAULT_REPO,
                   url: str = "", tag: str = "") -> bool:
    info = read_bundle_info(bundle, tag)
    version = info["version"]
    if appcast_path.exists():
        appcast = json.loads(appcast_path.read_text(encoding="utf-8"))
        if appcast.get("identifier") != info["identifier"]:
            raise ValueError("插件包的 identifier 与 appcast.json 不一致")
    else:
        appcast = {"identifier": info["identifier"], "versions": []}
    versions = appcast.get("versions", [])
    if not isinstance(versions, list):
        raise ValueError("appcast.json 的 versions 必须是数组")
    previous = next((entry for entry in versions if entry.get("version") == version), None)
    sha256 = hashlib.sha256(bundle.read_bytes()).hexdigest()
    if previous and previous.get("sha256") != sha256:
        raise ValueError(f"v{version} 已登记另一个 sha256，请复用已发布资产或发布新版本")
    entry = {
        "version": version,
        "desc": desc or f"v{version}",
        "sha256": sha256,
        "url": url or f"https://github.com/{repo}/releases/download/v{version}/{bundle.name}",
        "minBobVersion": info["minBobVersion"],
        "timestamp": previous.get("timestamp", int(time.time() * 1000)) if previous else int(time.time() * 1000),
    }
    updated = [value for value in versions if value.get("version") != version] + [entry]
    updated.sort(key=lambda value: version_key(str(value.get("version", "0"))), reverse=True)
    if versions == updated:
        print("appcast.json 没有变化")
        return False
    appcast["versions"] = updated
    # 原子替换，写入中断不会留下半份 JSON。
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=appcast_path.parent,
                                     prefix=".appcast-", delete=False) as file:
        temporary = Path(file.name)
        json.dump(appcast, file, ensure_ascii=False, indent=2)
        file.write("\n")
    try:
        os.replace(temporary, appcast_path)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"appcast.json 已更新：v{version} sha256={sha256}")
    print(f"下载地址：{entry['url']}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path, help="已上传的 .bobplugin 路径")
    descriptions = parser.add_mutually_exclusive_group()
    descriptions.add_argument("--desc", default=os.environ.get("APPCAST_DESC", ""), help="更新说明")
    descriptions.add_argument("--desc-file", type=Path, help="从 UTF-8 文件读取更新说明")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub 仓库 owner/name")
    parser.add_argument("--url", default="", help="覆盖默认下载地址")
    parser.add_argument("--tag", default="", help="核对发布标签与包内版本")
    parser.add_argument("--appcast", type=Path, default=ROOT / "appcast.json")
    args = parser.parse_args()
    try:
        desc = args.desc_file.read_text(encoding="utf-8").rstrip("\n") if args.desc_file else args.desc
        update_appcast(args.bundle, args.appcast, desc, args.repo, args.url, args.tag)
    except (OSError, ValueError) as err:
        print(f"appcast FAIL  {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
