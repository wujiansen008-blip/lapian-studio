#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一键发布到阿里云 OSS。

用法：
    python scripts/publish-oss.py

它会依次完成：
    1. 找到 release/ 下的安装包
    2. 上传为 LapianStudio-Setup-<版本>.exe
    3. 服务端复制一份 LapianStudio-Setup-latest.exe（下载页永远指向它）
    4. 更新下载页里的版本号并上传
    5. 打印公开链接

首次使用前，把 deploy/oss-config.example.json 复制成 deploy/oss-config.json，
填入 AccessKey。这个文件已经在 .gitignore 里，不会被提交。
"""

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "deploy" / "oss-config.json"
EXAMPLE_PATH = ROOT / "deploy" / "oss-config.example.json"
PAGE_PATH = ROOT / "deploy" / "index.html"
RELEASE_DIR = ROOT / "release"


def load_config():
    if not CONFIG_PATH.exists():
        print("缺少配置：", CONFIG_PATH)
        print("请先复制", EXAMPLE_PATH.name, "为", CONFIG_PATH.name, "并填入 AccessKey")
        sys.exit(1)
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def read_version():
    pkg = ROOT / "package.json"
    with open(pkg, encoding="utf-8") as f:
        return json.load(f)["version"]


def find_installer():
    if not RELEASE_DIR.exists():
        sys.exit("release 目录不存在，先运行 npm run dist 打包")
    files = sorted(
        [p for p in RELEASE_DIR.glob("*.exe") if "Setup" in p.name and p.stat().st_size > 50 * 1024 * 1024],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        sys.exit("release 目录下没有找到安装包，先运行 npm run dist")
    return files[0]


def main():
    cfg = load_config()
    try:
        import oss2
    except ImportError:
        sys.exit("缺少 oss2，请先执行：pip install oss2")

    version = read_version()
    installer = find_installer()
    size_mb = installer.stat().st_size / 1024 / 1024
    dry_run = "--dry-run" in sys.argv

    print("版本:", version)
    print("安装包:", installer.name, "|", round(size_mb), "MB")

    if dry_run:
        print()
        print("[dry-run] 配置和文件都正常，以下是将要执行的操作：")
        print("  上传为  LapianStudio-Setup-%s.exe" % version)
        print("  复制为  LapianStudio-Setup-latest.exe")
        print("  更新    index.html")
        return

    auth = oss2.Auth(cfg["accessKeyId"], cfg["accessKeySecret"])
    bucket = oss2.Bucket(auth, cfg["endpoint"], cfg["bucket"])

    versioned_key = "LapianStudio-Setup-%s.exe" % version
    latest_key = "LapianStudio-Setup-latest.exe"

    # 1. 上传版本化文件
    print("上传中…（分片，可能需要几分钟）")
    store = oss2.ResumableStore(root=str(ROOT / ".oss-store"))
    t0 = time.time()

    def on_progress(consumed, total):
        pct = consumed * 100 // total
        if pct % 10 == 0:
            print("  %d%%" % pct, flush=True)

    oss2.resumable_upload(
        bucket,
        versioned_key,
        str(installer),
        store=store,
        multipart_threshold=5 * 1024 * 1024,
        part_size=2 * 1024 * 1024,
        num_threads=4,
        progress_callback=on_progress,
    )
    print("上传完成，耗时 %.0f 秒" % (time.time() - t0))

    # 2. 下载时显示中文文件名
    cn_name = quote("拉片工作台 Setup %s.exe" % version)
    disp = {
        "Content-Disposition": (
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (versioned_key, cn_name)
        )
    }
    bucket.update_object_meta(versioned_key, disp)

    # 3. 服务端复制成 latest（秒级，不走本地带宽）
    bucket.copy_object(bucket.bucket_name, versioned_key, latest_key)
    bucket.update_object_meta(latest_key, disp)
    print("latest 已指向", version)

    # 4. 更新下载页版本号
    if PAGE_PATH.exists():
        html = PAGE_PATH.read_text(encoding="utf-8")
        html = re.sub(r"v\d+\.\d+\.\d+ · \d+ MB", "v%s · %d MB" % (version, round(size_mb)), html)
        PAGE_PATH.write_text(html, encoding="utf-8")
        bucket.put_object_from_file(
            "index.html",
            str(PAGE_PATH),
            headers={"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"},
        )
        print("下载页已更新")

    base = "https://%s.%s/" % (cfg["bucket"], cfg["endpoint"].replace("https://", ""))
    print()
    print("=== 发布完成 ===")
    print("下载页：", base + "index.html")
    print("直链  ：", base + latest_key)
    print()
    print("把「下载页」链接发出去即可，以后更新版本链接不用换。")


if __name__ == "__main__":
    main()
