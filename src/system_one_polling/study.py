from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from system_one_polling.profiles import ReaderProfile, SourceError, load_profiles, validate_cohort


CURRENT_MANIFEST_VERSION = "0.0.5"
MAX_MANIFEST_BYTES = 200_000
MAX_VISIBLE_BYTES = 80_000
_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_SHA256 = re.compile(r"^[a-fA-F0-9]{64}$")


@dataclass(frozen=True)
class SourceRecord:
    path: Path
    sha256: str


@dataclass(frozen=True)
class Study:
    _manifest_json: str
    profiles: tuple[ReaderProfile, ...]
    sources: tuple[SourceRecord, ...]
    manifest_dir: Path

    @property
    def manifest(self) -> dict:
        """Return an isolated copy so callers cannot mutate the validated study."""
        return json.loads(self._manifest_json)


def validate_manifest(data: object) -> dict:
    if not isinstance(data, dict) or data.get("version") != CURRENT_MANIFEST_VERSION:
        raise SourceError(f"Only manifest version {CURRENT_MANIFEST_VERSION} is supported")
    flow = data.get("reader_flow")
    required = {"version", "reader_flow", "title", "promise", "sources", "route", "conditions"}
    if flow == "scan_entry":
        required.add("scan_surface")
    elif flow != "article_route":
        raise SourceError("Manifest reader_flow must be article_route or scan_entry")
    if set(data) != required:
        raise SourceError("Current experiment manifest fields are invalid")
    if not all(isinstance(data[key], str) and data[key].strip() for key in ("title", "promise")):
        raise SourceError("Experiment title and promise must be nonempty")
    if not isinstance(data["sources"], list) or not isinstance(data["route"], list) or not data["route"]:
        raise SourceError("Experiment requires source records and an ordered route")

    seen: set[str] = set()
    route = [_validate_route_piece(piece, seen) for piece in data["route"]]
    if route[0]["kind"] != "beat" or route[-1]["kind"] != "beat":
        raise SourceError("Experiment route must open and end with an ordinary beat")
    if flow == "article_route":
        _validate_article_conditions(data["conditions"])
    else:
        _validate_scan_surface(data)

    canonical_route = [
        ({**piece,
          "preview": piece.get("preview", ""),
          "eyebrow": piece.get("eyebrow", ""),
          "disclosure_label": piece.get("disclosure_label", "")}
         if piece["kind"] == "optional_read" else piece)
        for piece in route
    ]
    canonical = {
        "version": CURRENT_MANIFEST_VERSION,
        "reader_flow": flow,
        "title": data["title"],
        "promise": data["promise"],
        "sources": copy.deepcopy(data["sources"]),
        "route": canonical_route,
        "conditions": copy.deepcopy(data["conditions"]),
    }
    if flow == "scan_entry":
        canonical["scan_surface"] = copy.deepcopy(data["scan_surface"])
    return canonical


def _validate_route_piece(piece: object, seen: set[str]) -> dict:
    if not isinstance(piece, dict) or piece.get("kind") not in {"beat", "optional_read"}:
        raise SourceError("Experiment route piece kind is invalid")
    kind = piece["kind"]
    required = ({"id", "kind", "text"} if kind == "beat" else
                {"id", "kind", "title", "standfirst", "reading_time", "body"})
    optional = {"preview", "eyebrow", "disclosure_label"} if kind == "optional_read" else set()
    if (not required <= set(piece) or set(piece) - required - optional or
            not isinstance(piece.get("id"), str) or not _ID.fullmatch(piece["id"])):
        raise SourceError("Experiment route piece fields or ID are invalid")
    if piece["id"] in seen:
        raise SourceError("Experiment route IDs are duplicated")
    if any(not isinstance(piece[key], str) or not piece[key].strip()
           for key in required - {"id", "kind"}):
        raise SourceError("Experiment route text is empty")
    if any(not isinstance(piece[field], str) for field in optional if field in piece):
        raise SourceError("Optional-read eyebrow and preview must be text")
    seen.add(piece["id"])
    return copy.deepcopy(piece)


def _validate_article_conditions(conditions: object) -> None:
    if not isinstance(conditions, list) or not conditions:
        raise SourceError("Article-route conditions are invalid")
    ids: set[str] = set()
    policies = {"core_only": "omit", "asides_in_flow": "inline",
                "optional_with_defer": "read_now_or_defer"}
    for condition in conditions:
        if (not isinstance(condition, dict) or set(condition) != {"id", "optional_reads"} or
                condition.get("id") not in policies or condition.get("id") in ids or
                condition.get("optional_reads") != policies.get(condition.get("id"))):
            raise SourceError("Article-route condition ID and optional-read policy are invalid")
        ids.add(condition["id"])


def _validate_scan_surface(data: dict) -> None:
    route = data["route"]
    surface = data.get("scan_surface")
    conditions = data["conditions"]
    if not isinstance(surface, list) or not surface:
        raise SourceError("Scan experiment requires an authored scan surface")
    if not isinstance(conditions, list) or not conditions:
        raise SourceError("Scanner conditions are invalid")

    by_id = {piece["id"]: piece for piece in route}
    entry_ids: set[str] = set()
    heading_targets: list[str] = []
    surfaced_targets: set[str] = set()
    for entry in surface:
        if not isinstance(entry, dict):
            raise SourceError("Scan surface entries must be objects")
        kind = entry.get("kind")
        expected = ({"id", "kind", "target", "text"} if kind in {"heading", "pull_quote"} else
                    {"id", "kind", "target", "title", "standfirst"} if kind == "aside" else set())
        target_id = entry.get("target")
        target = by_id.get(target_id) if isinstance(target_id, str) else None
        if kind == "aside" and target is not None:
            expected |= {field for field in ("eyebrow", "preview", "disclosure_label") if target.get(field)}
        if (not expected or set(entry) != expected or
                not isinstance(entry.get("id"), str) or not _ID.fullmatch(entry["id"]) or
                entry["id"] in entry_ids or not isinstance(target_id, str) or target_id not in by_id):
            raise SourceError("Scan surface entry fields, ID or target are invalid")
        if kind in {"heading", "pull_quote"}:
            if target["kind"] != "beat" or not isinstance(entry.get("text"), str) or not entry["text"].strip():
                raise SourceError("Headings and pull quotes must target a beat and contain text")
            if kind == "heading":
                heading_targets.append(target_id)
        else:
            visible = ("title", "standfirst", "eyebrow", "preview", "disclosure_label")
            if (target["kind"] != "optional_read" or
                    any(not isinstance(entry.get(field), str) or not entry[field].strip()
                        for field in ("title", "standfirst")) or
                    any(entry.get(field) != target.get(field) for field in visible if field in entry)):
                raise SourceError("Aside entries must show their target's exact visible invitation fields")
        entry_ids.add(entry["id"])
        surfaced_targets.add(target_id)

    beat_ids = {piece["id"] for piece in route if piece["kind"] == "beat"}
    optional_ids = {piece["id"] for piece in route if piece["kind"] == "optional_read"}
    if set(heading_targets) != beat_ids or len(heading_targets) != len(beat_ids):
        raise SourceError("Every article beat must have exactly one heading entry on the scan surface")
    if surfaced_targets != beat_ids | optional_ids:
        raise SourceError("Every beat and optional read must appear on the scan surface")

    condition_ids: set[str] = set()
    for condition in conditions:
        if (not isinstance(condition, dict) or
                set(condition) != {"id", "scan_features", "optional_reads"} or
                not isinstance(condition.get("id"), str) or not _ID.fullmatch(condition["id"]) or
                condition["id"] in condition_ids or not isinstance(condition.get("scan_features"), list) or
                any(not isinstance(feature, str) for feature in condition["scan_features"]) or
                len(set(condition["scan_features"])) != len(condition["scan_features"]) or
                set(condition["scan_features"]) - {"heading", "pull_quote", "aside"} or
                "heading" not in condition["scan_features"] or
                condition.get("optional_reads") not in {"omit", "inline", "read_now_or_defer"}):
            raise SourceError("Scanner conditions require a unique ID, heading feature and optional-read policy")
        condition_ids.add(condition["id"])


def load_study(manifest_path: Path, cohort_path: Path | None) -> Study:
    if cohort_path is None:
        raise SourceError("An explicit frozen reader cohort is required")
    manifest_path = manifest_path.resolve()
    try:
        raw = manifest_path.read_bytes()
        if not raw or len(raw) > MAX_MANIFEST_BYTES:
            raise SourceError("Experiment manifest is empty or too large")
        parsed = json.loads(raw.decode("utf-8-sig"))
    except SourceError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SourceError("Experiment manifest must be readable UTF-8 JSON") from error

    manifest = validate_manifest(parsed)
    if not manifest["sources"]:
        raise SourceError("Experiment requires at least one source hash")
    records: list[SourceRecord] = []
    for item in manifest["sources"]:
        if (not isinstance(item, dict) or set(item) != {"path", "sha256"} or
                not isinstance(item.get("path"), str) or not isinstance(item.get("sha256"), str) or
                not _SHA256.fullmatch(item["sha256"])):
            raise SourceError("Experiment source path or hash is invalid")
        raw_path = Path(item["path"])
        source_path = raw_path.resolve() if raw_path.is_absolute() else (manifest_path.parent / raw_path).resolve()
        try:
            actual = hashlib.sha256(source_path.read_bytes()).hexdigest()
        except OSError as error:
            raise SourceError("Experiment source path is missing or unreadable") from error
        expected = item["sha256"].lower()
        if actual != expected:
            raise SourceError("Experiment source hash has changed")
        records.append(SourceRecord(source_path, expected))

    archetype_path = Path(__file__).resolve().parents[2] / "skills" / "simulated-reader-polling" / "assets" / "reader-archetypes.json"
    try:
        archetypes = json.loads(archetype_path.read_text(encoding="utf-8"))
        known_archetypes = {item["id"] for item in archetypes if isinstance(item, dict) and isinstance(item.get("id"), str)}
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SourceError("Bundled reader archetype catalogue is unavailable") from error
    profiles = validate_cohort(load_profiles(cohort_path), known_archetypes)

    # Keep canonical source paths in the normalized manifest while fingerprints retain authored paths separately.
    manifest["sources"] = [{"path": str(record.path), "sha256": record.sha256} for record in records]
    visible_bytes = sum(len(piece.get("text", "").encode("utf-8")) +
                        len(piece.get("body", "").encode("utf-8"))
                        for piece in manifest["route"])
    if visible_bytes > MAX_VISIBLE_BYTES:
        raise SourceError("Experiment visible text exceeds the 80 KB study limit")
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True)
    return Study(encoded, profiles, tuple(records), manifest_path.parent)
