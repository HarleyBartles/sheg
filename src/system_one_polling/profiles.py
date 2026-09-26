from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


_PROFILE_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


class SourceError(ValueError):
    """A manifest, source, or reader cohort cannot be used safely."""


@dataclass(frozen=True)
class ReaderProfile:
    id: str
    arrival_intent: str
    background: str
    desired_payoff: str
    drawn_in_by: str = ""
    put_off_by: str = ""
    archetype_id: str = ""


def load_profiles(path: Path) -> tuple[ReaderProfile, ...]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SourceError("Reader cohort must be readable UTF-8 JSON") from error
    if not isinstance(data, list) or not data:
        raise SourceError("Reader cohort must contain at least one profile")

    profiles: list[ReaderProfile] = []
    seen: set[str] = set()
    base_fields = {"id", "arrival_intent", "background", "desired_payoff"}
    optional_fields = {"drawn_in_by", "put_off_by"}
    for entry in data:
        fields = set(entry) if isinstance(entry, dict) else set()
        if fields not in (base_fields, base_fields | optional_fields,
                          base_fields | {"archetype_id"},
                          base_fields | optional_fields | {"archetype_id"}):
            raise SourceError("Reader profile fields are invalid")
        if not all(isinstance(value, str) and value.strip() for value in entry.values()):
            raise SourceError("Reader profile fields must be nonempty text")
        if not _PROFILE_ID.fullmatch(entry["id"]) or entry["id"] in seen:
            raise SourceError("Reader profile ID is invalid or duplicated")
        if "archetype_id" in entry and not _PROFILE_ID.fullmatch(entry["archetype_id"]):
            raise SourceError("Reader archetype ID is invalid")
        if any(len(value) > 500 for value in entry.values()):
            raise SourceError("Reader profile fields must be under 500 characters")
        if ("drawn_in_by" in entry) != ("put_off_by" in entry):
            raise SourceError("Reader constraints drawn_in_by and put_off_by must be supplied together")
        seen.add(entry["id"])
        profiles.append(ReaderProfile(**entry))
    return tuple(profiles)


def validate_cohort(
    profiles: tuple[ReaderProfile, ...], known_archetypes: set[str],
) -> tuple[ReaderProfile, ...]:
    if not profiles or len({profile.id for profile in profiles}) != len(profiles):
        raise SourceError("A cohort needs at least one reader and distinct IDs")
    for profile in profiles:
        if not profile.archetype_id:
            raise SourceError(f"Reader {profile.id} needs an archetype")
        if profile.archetype_id not in known_archetypes:
            raise SourceError(f"Reader {profile.id} has an unknown archetype")
    return profiles
