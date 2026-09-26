from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from system_one_polling.study import SourceError, load_study


FIXTURES = Path(__file__).parent / "fixtures"


def _copy_study(tmp_path: Path, name: str) -> tuple[Path, Path]:
    manifest = tmp_path / f"{name}.json"
    cohort = tmp_path / "cohort.json"
    shutil.copy(FIXTURES / name, manifest)
    shutil.copy(FIXTURES / "cohort.json", cohort)
    source_name = "article-source.md" if name.startswith("article") else "scan-source.md"
    shutil.copy(FIXTURES / source_name, tmp_path / source_name)
    return manifest, cohort


def test_loads_v005_article_and_scan_studies_with_manifest_relative_sources(tmp_path: Path) -> None:
    article_path, cohort_path = _copy_study(tmp_path, "article-v005.json")
    scan_path = tmp_path / "scan-v005.json"
    shutil.copy(FIXTURES / "scan-v005.json", scan_path)
    shutil.copy(FIXTURES / "scan-source.md", tmp_path / "scan-source.md")

    article = load_study(article_path, cohort_path)
    scan = load_study(scan_path, cohort_path)

    assert article.manifest["reader_flow"] == "article_route"
    assert scan.manifest["reader_flow"] == "scan_entry"
    assert article.profiles[0].id == "reader-one"
    assert article.sources[0].path == (tmp_path / "article-source.md").resolve()
    assert article.sources[0].sha256 == hashlib.sha256(
        (tmp_path / "article-source.md").read_bytes()
    ).hexdigest()


@pytest.mark.parametrize("flow", ["article-v005.json", "scan-v005.json"])
def test_rejects_source_drift_before_a_run_can_be_created(tmp_path: Path, flow: str) -> None:
    manifest_path, cohort_path = _copy_study(tmp_path, flow)
    source = tmp_path / ("article-source.md" if flow.startswith("article") else "scan-source.md")
    source.write_text(source.read_text(encoding="utf-8") + "Changed after authoring.\n", encoding="utf-8")

    with pytest.raises(SourceError, match="hash"):
        load_study(manifest_path, cohort_path)


def test_rejects_wrong_source_sha256(tmp_path: Path) -> None:
    manifest_path, cohort_path = _copy_study(tmp_path, "article-v005.json")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["sources"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(SourceError, match="hash"):
        load_study(manifest_path, cohort_path)


@pytest.mark.parametrize("mutation, message", [
    ("duplicate", "duplicated"),
    ("unknown_archetype", "unknown archetype"),
])
def test_rejects_invalid_frozen_cohort(tmp_path: Path, mutation: str, message: str) -> None:
    manifest_path, cohort_path = _copy_study(tmp_path, "article-v005.json")
    cohort = json.loads(cohort_path.read_text(encoding="utf-8"))
    if mutation == "duplicate":
        cohort[1]["id"] = cohort[0]["id"]
    else:
        cohort[0]["archetype_id"] = "not-in-catalogue"
    cohort_path.write_text(json.dumps(cohort), encoding="utf-8")

    with pytest.raises(SourceError, match=message):
        load_study(manifest_path, cohort_path)


def test_requires_an_explicit_cohort(tmp_path: Path) -> None:
    manifest_path, _ = _copy_study(tmp_path, "article-v005.json")

    with pytest.raises(SourceError, match="cohort"):
        load_study(manifest_path, None)


def test_rejects_scan_entry_target_with_wrong_content_kind(tmp_path: Path) -> None:
    manifest_path, cohort_path = _copy_study(tmp_path, "scan-v005.json")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["scan_surface"][0]["target"] = "missing-piece"
    manifest_path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(SourceError, match="target"):
        load_study(manifest_path, cohort_path)
