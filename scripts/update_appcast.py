#!/usr/bin/env python3
"""把打好的 .bobplugin 登记到 appcast.json（Bob 靠它检查更新）。

用法：
    make pack
    make appcast DESC="首个版本"
    # 或者
    python3 scripts/update_appcast.py --bundle dist/bob-plugin-edge-tts-1.0.0.bobplugin --desc "首个版本"

版本号取自 src/info.json，sha256 现场计算，下载地址默认指向 GitHub Release：
    https://github.com/<repo>/releases/download/v<version>/<包名>
同版本重跑会替换记录而不是重复；versions 按语义版本倒序排列。
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPO = "poyih/bob-plugin-edge-tts"


def version_key(version: str) -> tuple:
    return tuple(int(part) if part.isdigit() else -1 for part in version.split("."))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", required=True, help="dist/ 里的 .bobplugin 路径")
    parser.add_argument("--desc", default="", help="更新说明")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub 仓库 owner/name")
    parser.add_argument("--url", default="", help="直接指定下载地址，覆盖按仓库推导的地址")
    args = parser.parse_args()

    info = json.loads((ROOT / "src" / "info.json").read_text(encoding="utf-8"))
    version = info["version"]
    bundle = Path(args.bundle)
    if not bundle.is_file():
        print(f"找不到包：{bundle}，请先 make pack", file=sys.stderr)
        return 1
    if version not in bundle.name:
        print(f"包名 {bundle.name} 与 src/info.json 的版本 {version} 不一致", file=sys.stderr)
        return 1

    sha256 = hashlib.sha256(bundle.read_bytes()).hexdigest()
    url = args.url or f"https://github.com/{args.repo}/releases/download/v{version}/{bundle.name}"

    appcast_path = ROOT / "appcast.json"
    if appcast_path.exists():
        appcast = json.loads(appcast_path.read_text(encoding="utf-8"))
    else:
        appcast = {"identifier": info["identifier"], "versions": []}
    appcast["identifier"] = info["identifier"]

    entry = {
        "version": version,
        "desc": args.desc or f"v{version}",
        "sha256": sha256,
        "url": url,
        "minBobVersion": info.get("minBobVersion", "1.8.0"),
        "timestamp": int(time.time() * 1000),
    }
    versions = [v for v in appcast.get("versions", []) if v.get("version") != version]
    versions.append(entry)
    versions.sort(key=lambda v: version_key(str(v.get("version", "0"))), reverse=True)
    appcast["versions"] = versions

    appcast_path.write_text(json.dumps(appcast, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"appcast.json 已更新：v{version} sha256={sha256}")
    print(f"下载地址：{url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
