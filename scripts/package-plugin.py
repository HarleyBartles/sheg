#!/usr/bin/env python3
"""Validate a Sheg release identity and assemble a deterministic plugin ZIP."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


def plugin_files() -> list[Path]:
    required = [
        Path("LICENSE"),
        Path("package.json"),
        Path("plugin.json"),
        Path("mcp.json"),
        Path(".agents/plugins/marketplace.json"),
    ]
    files = [*required]
    for directory in (Path("skills"), Path("dist")):
        root = ROOT / directory
        if root.is_symlink() or not root.is_dir():
            raise ValueError(f"required plugin directory is missing: {directory.as_posix()}")
        for path in root.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"plugin package cannot include symlinks: {path.relative_to(ROOT).as_posix()}")
            if path.is_file():
                files.append(path.relative_to(ROOT))
    missing = [path.as_posix() for path in required if not (ROOT / path).is_file()]
    if missing:
        raise ValueError(f"required plugin files are missing: {', '.join(missing)}")
    for relative in files:
        path = ROOT / relative
        if path.is_symlink():
            raise ValueError(f"plugin package cannot include symlinks: {relative.as_posix()}")
        try:
            path.resolve().relative_to(ROOT.resolve())
        except ValueError as error:
            raise ValueError(f"plugin package path escapes repository: {relative.as_posix()}") from error
    return sorted(set(files), key=lambda path: path.as_posix())


def release_version(tag: str) -> str:
    match = VERSION_PATTERN.fullmatch(tag)
    if not match:
        raise ValueError(f"invalid release tag {tag!r}; expected vMAJOR.MINOR.PATCH")
    return ".".join(match.groups())


def validate_tag(tag: str, triggering_commit: str | None = None) -> str:
    version = release_version(tag)
    package_version, _plugin_version = validate_manifests()
    if version != package_version:
        raise ValueError(f"release tag version {version} does not match manifest version {package_version}")
    if triggering_commit is not None:
        if not re.fullmatch(r"[0-9a-f]{40}", triggering_commit):
            raise ValueError(f"invalid triggering commit SHA: {triggering_commit!r}")
        try:
            tag_commit = subprocess.run(
                ["git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise ValueError(f"release tag {tag} does not resolve to a commit in this checkout") from error
        if tag_commit != triggering_commit:
            raise ValueError(
                f"release tag {tag} resolves to {tag_commit}, not triggering commit {triggering_commit}"
            )
    return version


def validate_manifests() -> tuple[str, str]:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    plugin = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    lockfile = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    if package.get("private") is not True:
        raise ValueError("package.json must remain private; npm publication is not supported")
    package_version = package.get("version")
    plugin_version = plugin.get("version")
    lock_root_version = lockfile.get("version")
    lock_packages = lockfile.get("packages")
    lock_package = lock_packages.get("") if isinstance(lock_packages, dict) else None
    lock_package_version = lock_package.get("version") if isinstance(lock_package, dict) else None
    if package_version != plugin_version:
        raise ValueError(
            f"manifest versions do not match: package.json={package_version!r}, plugin.json={plugin_version!r}"
        )
    if lock_root_version != package_version or lock_package_version != package_version:
        raise ValueError(
            "package versions do not match: "
            f"package.json={package_version!r}, package-lock.json={lock_root_version!r}, "
            f"package-lock.json packages['']={lock_package_version!r}"
        )
    version_pattern = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    if not isinstance(package_version, str) or not re.fullmatch(version_pattern, package_version):
        raise ValueError(f"invalid manifest version: {package_version!r}")
    return package_version, plugin_version


def create_archive(output: Path) -> list[str]:
    names = [path.as_posix() for path in plugin_files()]
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_STORED) as archive:
        for name in names:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = (0o100644 & 0xFFFF) << 16
            archive.writestr(info, (ROOT / name).read_bytes())
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Validate a vMAJOR.MINOR.PATCH release tag before packaging")
    parser.add_argument("--commit", help="Require the tag to resolve to this triggering GitHub event commit")
    parser.add_argument("--output", type=Path, help="ZIP output path")
    parser.add_argument("--validate-only", action="store_true", help="Validate tag and manifests without packaging")
    parser.add_argument("--list", type=Path, help="Print a JSON listing of an existing archive")
    args = parser.parse_args()
    try:
        if args.commit and not args.tag:
            raise ValueError("--commit requires --tag")
        if args.list:
            with zipfile.ZipFile(args.list) as archive:
                print(json.dumps(archive.namelist(), indent=2))
            return 0
        if args.tag:
            version = validate_tag(args.tag, args.commit)
        else:
            version, _plugin_version = validate_manifests()
        if args.validate_only:
            print(f"OK v{version} matches package.json, plugin.json, and package-lock.json")
            return 0
        output = args.output or Path("release-artifacts") / f"sheg-v{version}.zip"
        if not output.is_absolute():
            output = ROOT / output
        names = create_archive(output)
        print(f"Created {output} ({len(names)} files)")
        return 0
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
