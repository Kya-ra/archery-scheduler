import io
import json
import math
from pathlib import Path
import traceback

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components
from ortools.sat.python import cp_model

CONFIG_PATH = Path(__file__).resolve().with_name("config.json")

REQUIRED = [
    "First Name", "Last Name", "Bow Type", "College", "Gender",
    "Category", "Membership Number", "Which Days",
    "Session Preference",
]

VALID_HTH = {
    "BBO", "BBF", "BIO", "BIF", "BAO", "BAF",
    "RBO", "RBF", "RIO", "RIF", "RAO", "RAF", "CO", "CF",
}


def load_config():
    """Load the external configuration; do not silently substitute defaults."""
    if not CONFIG_PATH.is_file():
        raise FileNotFoundError(
            f"{CONFIG_PATH} was not found. Put config.json beside app.py."
        )
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read {CONFIG_PATH}: {exc}") from exc

    required_keys = {
        "default_session_by_college",
        "malleable_colleges",
        "session_days",
        "solver_time_limit_seconds",
        "college_short_names",
    }
    missing = sorted(required_keys - set(cfg))
    if missing:
        raise ValueError(
            f"{CONFIG_PATH} is missing required keys: {', '.join(missing)}"
        )
    if not isinstance(cfg["default_session_by_college"], dict):
        raise ValueError("default_session_by_college must be a JSON object.")
    if not isinstance(cfg["malleable_colleges"], list):
        raise ValueError("malleable_colleges must be a JSON array.")
    if not isinstance(cfg["session_days"], dict):
        raise ValueError("session_days must be a JSON object.")
    if not isinstance(cfg["college_short_names"], dict):
        raise ValueError("college_short_names must be a JSON object.")
    cfg["college_short_names"] = {
        str(college).strip().upper(): str(short_name).strip()
        for college, short_name in cfg["college_short_names"].items()
    }
    cfg["solver_time_limit_seconds"] = int(cfg["solver_time_limit_seconds"])
    return cfg

def normalize_headers(df):
    aliases = {
        str(c).strip().lower(): c for c in REQUIRED
    }
    aliases.update({
        "which days?": "Which Days",
        "which days": "Which Days",
        "shooting h2h": "Which Days",
        "ai number": "Membership Number",
        "open/female": "Gender",
    })

    df = df.copy()
    df.columns = [
        aliases.get(str(c).strip().lower(), str(c).strip())
        for c in df.columns
    ]

    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(
            "Missing required columns: " + ", ".join(missing)
        )

    for col in REQUIRED:
        df[col] = df[col].fillna("").astype(str).str.strip()

    df["College"] = df["College"].str.upper()
    df["Bow Type"] = df["Bow Type"].str.lower()
    df["Gender"] = df["Gender"].str.lower()
    df["Category"] = df["Category"].str.lower()
    df["Which Days"] = df["Which Days"].str.lower()
    # A binary "Shooting H2H" column expresses H2H eligibility, not which
    # calendar day someone attends. "no h2h" therefore remains eligible for
    # any configured session but is excluded from head-to-heads.
    attendance_aliases = {
        "1": "both days", "yes": "both days", "y": "both days",
        "true": "both days", "0": "no h2h", "no": "no h2h",
        "n": "no h2h", "false": "no h2h",
        "both": "both days", "both days": "both days",
        "saturday": "saturday only", "saturday only": "saturday only",
        "sunday": "sunday only", "sunday only": "sunday only",
    }
    df["Which Days"] = df["Which Days"].map(
        lambda value: attendance_aliases.get(value, value)
    )

    df["_id"] = df["Membership Number"].where(
        df["Membership Number"].ne(""),
        "row-" + pd.Series(range(len(df)), index=df.index).astype(str),
    )
    df["_name"] = df["First Name"] + " " + df["Last Name"]
    df["_face"] = df.apply(target_face, axis=1)
    df["_code"] = df.apply(category_code, axis=1)

    duplicates = df.loc[
        df["Membership Number"].ne("")
        & df["Membership Number"].duplicated(keep=False),
        "Membership Number",
    ].unique().tolist()

    if duplicates:
        raise ValueError(
            "Duplicate membership numbers: " + ", ".join(duplicates)
        )

    return df

def split_archer_name(value):
    """Split a combined name into first name and last name.

    First, detect IANSEO format, where the last name starts at the
    first all-uppercase token following mixed-case text.
    Otherwise, surname prefixes (O, Ó, Ní, Ni, Níc, Nic or Mac),
    matched case-insensitively, start the last name.
    As a fallback, assume the final token is the last name.
    """
    name = " ".join(str(value or "").strip().split())
    parts = name.split()

    if not parts:
        return "", ""

    # IANSEO format, e.g. "Pádraig MAC LOCHLAINN"
    for i, part in enumerate(parts):
        if part.isupper() and any(c.isalpha() for c in part):
            if i > 0 and any(
                c.islower() for previous in parts[:i] for c in previous
            ):
                return " ".join(parts[:i]), " ".join(parts[i:])

    # Irish surname prefixes, e.g. "Pádraig Mac Lochlainn"
    surname_prefixes = {"o", "ó", "ní", "ni", "níc", "nic", "mac"}

    for i, part in enumerate(parts):
        if part.casefold() in surname_prefixes:
            return " ".join(parts[:i]), " ".join(parts[i:])

    # Default: final token is the last name
    if len(parts) >= 2:
        return " ".join(parts[:-1]), parts[-1]

    return parts[0], ""

def read_entry_file(uploaded):
    """Read CSV, TSV, ODS, or XLSX, including headerless IANSEO List Load files."""
    filename = uploaded.name.lower()
    content = uploaded.getvalue()

    ianseo_columns = [
        "Bib",
        "Session",
        "Division",
        "Class",
        "Target",
        "Individual - Division/Class",
        "Team - Division/Class",
        "Ind. Events",
        "Team Events",
        "Mixed Team Events",
        "Family Name",
        "Name",
        "Gender",
        "Country",
        "Country Name",
        "Date of Birth",
        "Subclass",
        "Country 2",
        "Country Name 2",
        "Country 3",
        "Country Name 3",
    ]

    def looks_like_headerless_ianseo(raw):
        if raw.shape[1] != len(ianseo_columns) or raw.empty:
            return False

        first = str(raw.iloc[0, 0]).strip().lower()
        known_headers = {
            "bib",
            "membership number",
            "first name",
            "archer",
            "name",
        }
        return first not in known_headers

    def read_spreadsheet(engine=None):
        kwargs = {
            "io": io.BytesIO(content),
            "dtype": str,
        }
        if engine:
            kwargs["engine"] = engine

        raw = pd.read_excel(
            **kwargs,
            header=0,
        ).fillna("")

        if looks_like_headerless_ianseo(raw):
            raw = pd.read_excel(
                io.BytesIO(content),
                dtype=str,
                header=None,
                **({"engine": engine} if engine else {}),
            ).fillna("")

            if raw.shape[1] == len(ianseo_columns):
                raw.columns = ianseo_columns

        return raw

    if filename.endswith(".xlsx"):
        return read_spreadsheet()

    if filename.endswith(".ods"):
        return read_spreadsheet(engine="odf")

    if filename.endswith((".csv", ".tsv", ".tab", ".txt")):
        sample = content[:16384].decode(
            "utf-8-sig",
            errors="replace",
        )

        if filename.endswith((".tsv", ".tab")):
            delimiter = "\t"
        else:
            delimiter = (
                "\t"
                if sample.count("\t") > sample.count(",")
                else ","
            )

        raw = pd.read_csv(
            io.BytesIO(content),
            sep=delimiter,
            dtype=str,
            keep_default_na=False,
            encoding="utf-8-sig",
        )

        if looks_like_headerless_ianseo(raw):
            raw.columns = ianseo_columns

        return raw

    raise ValueError(
        "Unsupported file type. Upload CSV, TSV, TAB, TXT, XLSX, or ODS."
    )

def prepare_import_roster(raw):
    """Convert scheduler exports, IANSEO exports, and roster files to REQUIRED columns."""
    raw = raw.copy()

    if raw.empty:
        return pd.DataFrame(columns=REQUIRED)

    raw.columns = [str(c).strip() for c in raw.columns]

    # Detect our own headerless IANSEO List Load export.
    if _looks_like_ianseo_headerless(raw):
        raw.columns = IANSEO_COLUMNS

    # Case-insensitive lookup, retaining original column names.
    lookup = {
        str(column).strip().lower(): column
        for column in raw.columns
    }

    def find_column(*names):
        for name in names:
            column = lookup.get(name.strip().lower())
            if column is not None:
                return column
        return None

    def source(*names):
        column = find_column(*names)
        if column is None:
            return pd.Series("", index=raw.index, dtype=str)
        return raw[column].fillna("").astype(str).str.strip()

    mapped = pd.DataFrame(index=raw.index)

    # First map the common roster columns and aliases.
    aliases = {
        "First Name": (
            "First Name", "Given Name", "Forename",
        ),
        "Last Name": (
            "Last Name", "Family Name", "Surname",
        ),
        "Bow Type": (
            "Bow Type", "Bow", "Division Name",
        ),
        "College": (
            "College", "Club", "Country Name", "Country", "Club Name",
        ),
        "Gender": (
            "Gender", "Sex", "Open/Female",
        ),
        "Category": (
            "Category", "Skill Category", "Age Category",
        ),
        "Membership Number": (
            "Membership Number", "AI Number", "Bib",
            "Bib Number", "Archer Number", "ID",
        ),
        "Which Days": (
            "Which Days", "Which Days?", "Shooting H2H",
            "H2H", "Attendance",
        ),
        "Session Preference": (
            "Session Preference", "Preferred Session",
            "Session Preference(s)",
        ),
    }

    for field, names in aliases.items():
        mapped[field] = source(*names)

    # Split combined archer names when separate name columns are unavailable.
    # Prefer an explicit family/given-name pair whenever both exist.
    combined_col = find_column("Archer", "Archer Name", "Full Name", "Name")
    family_col = find_column("Family Name", "Last Name", "Surname")
    given_col = find_column("First Name", "Given Name", "Forename")

    if combined_col is not None and family_col is None and given_col is None:
        combined = source("Archer", "Archer Name", "Full Name", "Name")

        def split_name(value):
            if not value:
                return "", ""

            first, last = split_archer_name(value)
            return str(first).strip(), str(last).strip()

        split_names = combined.map(split_name)
        mapped["First Name"] = split_names.map(lambda pair: pair[0])
        mapped["Last Name"] = split_names.map(lambda pair: pair[1])

    # IANSEO format: Family Name and Name are separate fields.
    # Only treat Name as a given name when Family Name is present.
    if find_column("Family Name") is not None:
        mapped["Last Name"] = source("Family Name")

        if find_column("Name") is not None and given_col is None:
            mapped["First Name"] = source("Name")

    # Reconstruct bow, category, and gender from IANSEO Division/Class.
    division_col = find_column("Division")
    class_col = find_column("Class")

    if division_col is not None and class_col is not None:
        division = source("Division").str.upper()
        class_value = source("Class").str.upper()

        bow_map = {
            "B": "barebow",
            "R": "recurve",
            "C": "compound",
        }

        for idx in raw.index:
            division_code = division.at[idx]
            class_code = division_code + class_value.at[idx]

            # Fill the bow type only if no explicit bow type was supplied.
            if not mapped.at[idx, "Bow Type"]:
                mapped.at[idx, "Bow Type"] = bow_map.get(
                    division_code, ""
                )

            # Prefer the full code so guest and senior league classes
            # are decoded correctly for every bow type.
            if class_code in {
                "BBO", "BBF", "BIO", "BIF", "BAO", "BAF",
                "RBO", "RBF", "RIO", "RIF", "RAO", "RAF",
                "BG", "BS", "RG", "RS", "CO", "CF", "CG", "CS",
            }:
                fields = class_code_to_fields(
                    class_code,
                    {
                        "Gender": mapped.at[idx, "Gender"],
                        "Category": mapped.at[idx, "Category"],
                    },
                )

                if not mapped.at[idx, "Bow Type"]:
                    mapped.at[idx, "Bow Type"] = fields["Bow Type"]

                # An explicit category/gender takes precedence.
                if not mapped.at[idx, "Category"]:
                    mapped.at[idx, "Category"] = fields["Category"]

                if not mapped.at[idx, "Gender"]:
                    mapped.at[idx, "Gender"] = fields["Gender"]

            else:
                class_part = class_value.at[idx]

                if not mapped.at[idx, "Category"]:
                    if class_part in {"G", "CG", "BG", "RG"}:
                        mapped.at[idx, "Category"] = "guest"
                    elif class_part in {"S", "CS", "BS", "RS"}:
                        mapped.at[idx, "Category"] = "senior league"
                    elif class_part:
                        ability_map = {
                            "B": "beginner",
                            "I": "intermediate",
                            "A": "advanced",
                        }
                        mapped.at[idx, "Category"] = ability_map.get(
                            class_part[0], ""
                        )

                if not mapped.at[idx, "Gender"]:
                    if class_part.endswith("F"):
                        mapped.at[idx, "Gender"] = "female"
                    elif class_part.endswith("O"):
                        mapped.at[idx, "Gender"] = "open"

    # IANSEO does not directly encode the original attendance field.
    # Event indicators provide a best-effort hint, unless a real attendance
    # or H2H column was already supplied.
    if find_column(
        "Which Days", "Which Days?", "Shooting H2H",
        "H2H", "Attendance",
    ) is None:
        event_columns = [
            find_column("Ind. Events"),
            find_column("Team Events"),
            find_column("Mixed Team Events"),
        ]
        event_columns = [column for column in event_columns if column is not None]

        if event_columns:
            event_values = raw[event_columns].fillna("").astype(str)
            mapped["Which Days"] = event_values.apply(
                lambda row: (
                    "both days"
                    if any(value.strip() == "1" for value in row)
                    else "no h2h"
                ),
                axis=1,
            )
        else:
            mapped["Which Days"] = "both days"

    # An IANSEO session is an actual allocation, not necessarily a preference.
    # Keep it available to restore_imported_draw() in the raw source; don't
    # silently treat it as a preference in the roster.
    return normalize_headers(mapped[REQUIRED])


def restore_imported_draw(raw, archers):
    """
    Restore an existing scheduler or IANSEO draw.

    Supported allocation formats:
      - Scheduler exports with separate Session, Target and Position.
      - Exports with combined targets such as 14A.
      - IANSEO exports with Bib, Session, Target, Name and Family Name.
      - Headerless IANSEO List Load files using IANSEO_COLUMNS.

    Raises ValueError on missing, ambiguous or invalid allocation data.
    Never generates replacement allocations.
    """
    import re
    import pandas as pd

    if raw is None or raw.empty:
        raise ValueError("The imported file contains no data rows.")

    raw = raw.copy()
    raw.columns = [str(c).strip() for c in raw.columns]

    # Recognise our headerless IANSEO List Load format.
    if _looks_like_ianseo_headerless(raw):
        raw.columns = IANSEO_COLUMNS

    # Resolve headers case-insensitively, tolerating surrounding whitespace.
    def key(value):
        return re.sub(
            r"[^a-z0-9]+", " ",
            str(value).strip().lower()
        ).strip()

    columns = {}
    for column in raw.columns:
        normalized = key(column)
        if normalized and normalized not in columns:
            columns[normalized] = column

    def find_column(*aliases):
        for alias in aliases:
            found = columns.get(key(alias))
            if found is not None:
                return found
        return None

    def cell(row, column):
        if column is None:
            return ""
        value = row[column]
        if pd.isna(value):
            return ""
        value = str(value).strip()
        # Excel frequently converts identifiers like 123 to 123.0.
        if re.fullmatch(r"\d+\.0", value):
            value = value[:-2]
        return value

    session_col = find_column(
        "Session", "Session Number", "Shooting Session"
    )
    target_col = find_column(
        "Target", "Target Number", "Target No.",
        "Target Allocation", "Target/Position",
        "Target No. Position"
    )
    position_col = find_column(
        "Position", "Target Position Letter", "Lane", "Letter"
    )
    bib_col = find_column(
        "Membership Number", "AI Number", "Bib",
        "Bib Number", "Archer Number", "ID"
    )
    given_col = find_column(
        "First Name", "Given Name", "Forename", "Name"
    )
    family_col = find_column(
        "Last Name", "Family Name", "Surname"
    )
    combined_name_col = find_column(
        "Archer", "Archer Name", "Full Name"
    )
    face_col = find_column(
        "Target Face", "Target Type", "Face Type"
    )

    # An absent allocation schema is an error in copy mode.
    if session_col is None:
        raise ValueError(
            "Cannot copy the existing schedule: no Session column found. "
            f"Available columns: {list(raw.columns)}"
        )

    if target_col is None:
        raise ValueError(
            "Cannot copy the existing schedule: no Target column found. "
            "Expected a target number, optionally with a position letter."
        )

    if bib_col is None and combined_name_col is None:
        if given_col is None or family_col is None:
            raise ValueError(
                "Cannot match imported allocations to archers. "
                "Provide Bib/Membership Number, an Archer column, "
                "or separate Name and Family Name columns."
            )

    # Normalise the roster using the application's existing rules.
    roster = normalize_headers(archers[REQUIRED].copy())

    if roster.empty:
        raise ValueError("Cannot restore a draw against an empty roster.")

    def normalize_member(value):
        value = str(value).strip()
        if re.fullmatch(r"\d+\.0", value):
            value = value[:-2]
        return value

    roster["Membership Number"] = (
        roster["Membership Number"]
        .fillna("")
        .map(normalize_member)
    )

    def normalize_name(value):
        return " ".join(str(value).casefold().split())

    roster_by_bib = {}
    roster_by_name = {}

    for _, archer in roster.iterrows():
        bib = normalize_member(archer["Membership Number"])

        if bib:
            if bib in roster_by_bib:
                raise ValueError(
                    f"The roster contains duplicate membership number {bib!r}."
                )
            roster_by_bib[bib] = archer

        name = normalize_name(archer["_name"])
        if name:
            if name in roster_by_name:
                # Keep the ambiguity explicit instead of silently selecting
                # the wrong archer when matching by name.
                roster_by_name[name] = None
            elif name not in roster_by_name:
                roster_by_name[name] = archer

    # Validate every allocation row; do not silently skip malformed rows.
    restored = []
    seen_archers = {}
    seen_positions = set()
    seen_sessions = set()

    for row_index, (_, source) in enumerate(raw.iterrows()):
        # Spreadsheet row number, accounting for the header.
        sheet_row = row_index + 2

        session_text = cell(source, session_col)
        target_text = cell(source, target_col)
        position_text = cell(source, position_col).upper()

        if not session_text:
            raise ValueError(
                f"Session is blank on spreadsheet row {sheet_row}. "
                "No schedule was copied."
            )

        if not re.fullmatch(r"\d+", session_text):
            raise ValueError(
                f"Invalid session {session_text!r} on spreadsheet "
                f"row {sheet_row}."
            )

        session = int(session_text)
        if session < 1:
            raise ValueError(
                f"Session must be at least 1 on spreadsheet row {sheet_row}."
            )

        if not target_text:
            raise ValueError(
                f"Target is blank on spreadsheet row {sheet_row}."
            )

        # Accept a combined allocation such as 14A or 14 A.
        match = re.fullmatch(
            r"(\d+)\s*([ABCD])", target_text.upper()
        )

        if match:
            target = int(match.group(1))
            combined_position = match.group(2)

            if position_text and position_text != combined_position:
                raise ValueError(
                    f"Conflicting target positions on spreadsheet row "
                    f"{sheet_row}: {combined_position!r} in Target and "
                    f"{position_text!r} in Position."
                )

            position = combined_position
        else:
            if not re.fullmatch(r"\d+", target_text):
                raise ValueError(
                    f"Cannot parse target {target_text!r} on spreadsheet "
                    f"row {sheet_row}. Expected a number or allocation "
                    "such as '14A'."
                )

            target = int(target_text)
            position = position_text

            if position not in {"A", "B", "C", "D"}:
                raise ValueError(
                    f"Invalid or missing position {position!r} on "
                    f"spreadsheet row {sheet_row}. A numeric target "
                    "requires a separate A/B/C/D Position."
                )

        if target < 1:
            raise ValueError(
                f"Target must be at least 1 on spreadsheet row {sheet_row}."
            )

        allocation = (session, target, position)
        if allocation in seen_positions:
            raise ValueError(
                f"Duplicate allocation {session}/{target}{position} "
                f"on spreadsheet row {sheet_row}."
            )
        seen_positions.add(allocation)
        seen_sessions.add(session)

        # Prefer stable membership numbers. Use names only when the import
        # genuinely has no identifier for this archer.
        member = cell(source, bib_col)
        archer = None

        if member:
            archer = roster_by_bib.get(normalize_member(member))
            if archer is None:
                raise ValueError(
                    f"Spreadsheet row {sheet_row} references membership "
                    f"number {member!r}, which is not in the roster. "
                    "Check that the imported schedule and roster match."
                )
        else:
            given = cell(source, given_col)
            family = cell(source, family_col)
            combined = cell(source, combined_name_col)

            if given or family:
                # IANSEO provides Name = given name and
                # Family Name = surname.
                imported_name = " ".join(
                    part for part in (given, family) if part
                )
            elif combined:
                # Scheduler exports commonly display "First Last".
                # split_archer_name is the app's existing name parser.
                first, last = split_archer_name(combined)
                imported_name = " ".join(
                    part for part in (first, last) if part
                )
            else:
                raise ValueError(
                    f"No membership number or usable name on spreadsheet "
                    f"row {sheet_row}."
                )

            name_key = normalize_name(imported_name)
            if name_key not in roster_by_name:
                raise ValueError(
                    f"Could not match {imported_name!r} on spreadsheet "
                    f"row {sheet_row} to a roster member."
                )

            archer = roster_by_name[name_key]
            if archer is None:
                raise ValueError(
                    f"The name {imported_name!r} on spreadsheet row "
                    f"{sheet_row} matches multiple roster members. "
                    "Supply membership numbers to disambiguate."
                )

            member = normalize_member(archer["Membership Number"])

        if member in seen_archers:
            raise ValueError(
                f"Archer {archer['_name']!r} has multiple imported "
                f"allocations (rows {seen_archers[member]} and "
                f"{sheet_row}). Each archer must have exactly one "
                "allocation in the imported draw."
            )
        seen_archers[member] = sheet_row

        # Preserve a recognised face from the import; otherwise use the
        # face derived by the app's existing roster normalisation.
        imported_face = cell(source, face_col).lower()
        if imported_face in {"3s", "40", "vegas"}:
            face = "Vegas" if imported_face == "vegas" else imported_face
        else:
            face = archer["_face"]

        restored.append({
            "Session": session,
            "Target": target,
            "Position": position,
            "Archer": archer["_name"],
            "First Name": archer["First Name"],
            "Last Name": archer["Last Name"],
            "College": archer["College"],
            "Bow Type": archer["Bow Type"],
            "Target Face": face,
            "Category": archer["Category"],
            "Gender": archer["Gender"],
            "Which Days": archer["Which Days"],
            "Membership Number": member,
            "Category Code": archer["_code"],
            "Session Preference": archer["Session Preference"],
            "Head-to-Head Eligible": hth_eligible(archer),
        })

    if not restored:
        raise ValueError(
            "No valid allocations were found. No schedule was copied."
        )

    sessions = sorted(seen_sessions)
    expected_sessions = list(range(1, max(sessions) + 1))

    if sessions != expected_sessions:
        raise ValueError(
            "Imported sessions must be numbered consecutively from 1. "
            f"Found sessions: {sessions}."
        )

    draw = pd.DataFrame(restored)

    return draw.sort_values(
        ["Session", "Target", "Position"]
    ).reset_index(drop=True)

def target_face(row):
    bow = row["Bow Type"]
    gender = row["Gender"]
    category = row["Category"]

    if "compound" in bow:
        return "3s"

    if "recurve" in bow:
        if category in ("advanced", "guest", "senior league") or gender in ("guest", "senior league"):
            return "3s"
        return "40"

    if "barebow" in bow:
        return "40"

    raise ValueError(
        f"Unknown bow type for {row['_name']}: {row['Bow Type']}"
    )

def category_code(row):
    gender = str(row["Gender"]).strip().lower()
    category = str(row["Category"]).strip().lower()
    bow = str(row["Bow Type"]).strip().lower()

    prefix = (
        "C" if "compound" in bow
        else "B" if "barebow" in bow
        else "R" if "recurve" in bow
        else ""
    )
    if not prefix:
        return ""

    # Guest and Senior League can be recorded in either field.
    special_class = next(
        (
            value
            for value in ("guest", "senior league")
            if value in (gender, category)
        ),
        None,
    )

    # Compound classes use CO/CF, CG, or CS.
    if prefix == "C":
        if special_class == "guest":
            return "CG"
        if special_class == "senior league":
            return "CS"
        return "CF" if gender in ("female", "f") else "CO"

    if special_class == "guest":
        return prefix + "G"
    if special_class == "senior league":
        return prefix + "S"

    ability = {
        "beginner": "B",
        "intermediate": "I",
        "advanced": "A",
    }.get(category, "")

    if not ability:
        return ""

    sex = "F" if gender in ("female", "f") else "O"
    return prefix + ability + sex

def hth_eligible(row):
    # Saturday-only archers compete in the shooting session,
    # but cannot enter head-to-heads.
    if row["Which Days"] != "both days":
        return False

    # Guest and Senior League are always excluded.
    if row["Gender"] in ("guest", "senior league"):
        return False

    if row["Category"] in ("guest", "senior league"):
        return False

    return row["_code"] in VALID_HTH

def is_special(row):
    return (
        row["_face"] == "3s"
        or row["Category"] in ("intermediate", "advanced")
        or row["Gender"] in ("guest", "senior league")
        or row["Category"] in ("guest", "senior league")
    )

def parse_session_preferences(value):
    """Parse a blank, single session, or comma-separated session list."""
    result = []
    for part in str(value).split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            raise ValueError(
                f"Invalid session preference {value!r}; use numbers separated by commas."
            )
        number = int(part)
        if number not in result:
            result.append(number)
    return result

def college_default(row, cfg):
    college = row["College"].upper()

    malleable = {
        str(c).strip().upper()
        for c in cfg["malleable_colleges"]
    }

    # Individual preferences override college defaults.
    if parse_session_preferences(row["Session Preference"]):
        return None

    if college in malleable:
        return None

    defaults = {
        str(k).strip().upper(): int(v)
        for k, v in cfg["default_session_by_college"].items()
    }

    return defaults.get(college)

def eligible_for_session(row, session_number, cfg):
    session_day = str(
        cfg["session_days"].get(str(session_number), "")
    ).strip().lower()

    attendance = row["Which Days"]

    if not session_day or attendance in ("both days", "no h2h"):
        return True

    if attendance == "saturday only":
        return "saturday" in session_day

    if attendance == "sunday only":
        return "sunday" in session_day

    return False

def solve_schedule(
    df,
    targets,
    details,
    cfg,
    campanile_mode=True,
    forced_sessions=None,
    existing_draw=None,
    face_overrides=None,
    clustering_mode=False,
    vegas_mode=False,
):
    if clustering_mode:
        campanile_mode = False

    n = len(df)
    ns = len(targets)
    forced_sessions = forced_sessions or {}
    face_overrides = face_overrides or {}

    capacities = [
        targets[s] * (4 if details[s] == "Double" else 2)
        for s in range(ns)
    ]

    if sum(capacities) < n:
        raise ValueError(
            f"Only {sum(capacities)} places for {n} archers."
        )

    # Validate explicit session preferences before solving.
    for _, row in df.iterrows():
        prefs = parse_session_preferences(row["Session Preference"])
        invalid = [p for p in prefs if p < 1 or p > ns]
        if invalid:
            raise ValueError(
                f"{row['_name']} requested invalid session(s): "
                + ", ".join(map(str, invalid))
            )

    for s in range(ns):
        wanted = sum(
            s + 1 in parse_session_preferences(row["Session Preference"])
            for _, row in df.iterrows()
        )
        if wanted > capacities[s]:
            raise ValueError(
                f"{wanted} archers requested session {s + 1}, "
                f"but it has only {capacities[s]} places."
            )

    model = cp_model.CpModel()
    x = {}
    archer_vars = {a: [] for a in range(n)}
    session_vars = {s: [] for s in range(ns)}
    slot_vars = {}
    face_vars = {}

    for s in range(ns):
        letters = (
            ["A", "B"] if details[s] == "Single"
            else ["A", "B", "C", "D"]
        )

        for t in range(targets[s]):
            face_keys = ["A"] if details[s] == "Single" else ["A", "B"]
            for face_key in face_keys:
                f3 = model.NewBoolVar(f"3s_{s}_{t}_{face_key}")
                f40 = model.NewBoolVar(f"40_{s}_{t}_{face_key}")
                model.Add(f3 + f40 <= 1)
                face_vars[(s, t, face_key)] = (f3, f40)
            if details[s] == "Double" and not vegas_mode:
                # A/C and B/D are the physical face pairs. If B/D is 3s,
                # A/C must also be 3s, so the mixed arrangement is consistent.
                model.Add(
                    face_vars[(s, t, "B")][0]
                    <= face_vars[(s, t, "A")][0]
                )

            for letter in letters:
                slot_vars[(s, t, letter)] = []
                if details[s] == "Single":
                    face_key = "A"
                else:
                    face_key = "A" if letter in ("A", "C") else "B"
                f3, f40 = face_vars[(s, t, face_key)]

                for a, row in df.iterrows():
                    var = model.NewBoolVar(
                        f"x_{a}_{s}_{t}_{letter}"
                    )

                    x[(a, s, t, letter)] = var
                    archer_vars[a].append(var)
                    session_vars[s].append(var)
                    slot_vars[(s, t, letter)].append(var)

                    # Integer row indices identify individual archers, including duplicates.
                    if a in forced_sessions:
                        if s + 1 != int(forced_sessions[a]):
                            model.Add(var == 0)
                    else:
                        # Backward compatibility for existing callers using membership numbers.
                        member_number = str(row["Membership Number"]).strip()
                        if member_number in forced_sessions:
                            if s + 1 != int(forced_sessions[member_number]):
                                model.Add(var == 0)

                    # Explicit face overrides take priority over the roster-derived face.
                    face_type = face_overrides.get(a, row["_face"])
                    is_vegas = vegas_mode and str(face_type).lower() in {
                        "3s", "vegas",
                    }

                    if is_vegas:
                        pass
                    elif face_type == "3s":
                        model.Add(var <= f3)
                    elif face_type == "40":
                        model.Add(var <= f40)
                    else:
                        raise ValueError(
                            f"Unexpected target face type {face_type!r} "
                            f"for archer row {a}."
                        )

    # Each archer appears exactly once.
    for a in range(n):
        model.Add(sum(archer_vars[a]) == 1)

    # Each position can hold at most one archer.
    for variables in slot_vars.values():
        model.Add(sum(variables) <= 1)

    clustering_score = []
    clustering_score_bound = 0
    cluster_order_score = []
    cluster_order_score_bound = 0
    if clustering_mode:
        cluster_order = ["C", "BB", "BI", "BA", "RB", "RI", "RA"]

        def cluster_class(code):
            normalized = str(code).strip().upper()
            if not normalized:
                return "Other"
            if normalized.startswith("C"):
                return "C"
            return normalized[:2]

        class_buckets = {cluster_class(code) for code in df["_code"]}
        class_buckets = sorted(
            class_buckets,
            key=lambda bucket: (
                cluster_order.index(bucket)
                if bucket in cluster_order
                else len(cluster_order),
                bucket,
            ),
        )
        bucket_rank = {
            bucket: rank for rank, bucket in enumerate(class_buckets)
        }

        for s in range(ns):
            letters = (
                ["A", "B"] if details[s] == "Single"
                else ["A", "B", "C", "D"]
            )

            for t in range(targets[s]):
                for a, row in df.iterrows():
                    rank = bucket_rank[cluster_class(row["_code"])]
                    order_weight = (
                        100
                        * (len(class_buckets) - rank)
                        * (targets[s] - t)
                    )
                    cluster_order_score.extend(
                        order_weight * x[(a, s, t, letter)]
                        for letter in letters
                    )
                    cluster_order_score_bound += order_weight * len(letters)

                for class_bucket in class_buckets:
                    members = [
                        x[(a, s, t, letter)]
                        for a, row in df.iterrows()
                        if cluster_class(row["_code"]) == class_bucket
                        for letter in letters
                    ]
                    class_count = model.NewIntVar(
                        0, len(letters),
                        f"class_count_{s}_{t}_{class_bucket}"
                    )
                    model.Add(class_count == sum(members))

                    # Reward each same-class pair: counts 2, 3 and 4 score
                    # 1, 3 and 6 respectively, without pairwise slot vars.
                    for threshold, weight in ((2, 1), (3, 2), (4, 3)):
                        if threshold > len(letters):
                            continue
                        reaches_threshold = model.NewBoolVar(
                            f"class_{s}_{t}_{class_bucket}_at_least_{threshold}"
                        )
                        model.Add(class_count >= threshold * reaches_threshold)
                        model.Add(
                            class_count
                            <= threshold - 1
                            + (len(letters) - threshold + 1)
                            * reaches_threshold
                        )
                        clustering_score.append(weight * reaches_threshold)
                        clustering_score_bound += weight

    # Target composition constraints: every used target must contain at
    # least two distinct clubs. Penalise (rather than prohibit) three or more
    # archers from one club, so the solver can still find a valid draw.
    club_penalties = []
    campanile_penalties = []
    for s in range(ns):
        letters = ["A", "B"] if details[s] == "Single" else ["A", "B", "C", "D"]
        clubs = sorted(set(df["College"].astype(str).str.upper()))
        for t in range(targets[s]):
            target_vars = [x[(a, s, t, letter)] for a in range(n) for letter in letters]

            if vegas_mode:
                vegas_archers = [
                    x[(a, s, t, letter)]
                    for a, row in df.iterrows()
                    if str(face_overrides.get(a, row["_face"])).lower()
                    in {"3s", "vegas"}
                    for letter in letters
                ]
                model.Add(sum(vegas_archers) <= 4)

            club_presence = {}
            for club_index, club in enumerate(clubs):
                present = model.NewBoolVar(f"club_{s}_{t}_{club_index}")
                club_presence[club] = present
                club_members = [
                    x[(a, s, t, letter)]
                    for a, row in df.iterrows()
                    if str(row["College"]).upper() == club
                    for letter in letters
                ]
                if club_members:
                    model.Add(sum(club_members) >= present)
                    model.Add(sum(club_members) <= len(letters) * present)
                else:
                    model.Add(present == 0)
                # Soft preference: avoid three archers from the same club.
                too_many = model.NewBoolVar(f"club_triplet_{s}_{t}_{club_index}")
                model.Add(sum(club_members) <= 2 + len(letters) * too_many)
                model.Add(sum(club_members) >= 3 * too_many)
                club_penalties.append(too_many)
            # The model fills target blocks; requiring two club indicators
            # therefore enforces the two-club rule on each occupied target.
            model.Add(sum(club_presence.values()) >= 2)

            if campanile_mode:
                non_beginners = [
                    x[(a, s, t, letter)]
                    for a, row in df.iterrows()
                    if str(row["Category"]).strip().lower() != "beginner"
                    for letter in letters
                ]
                # Every target must have at least one non-beginner archer.
                model.Add(sum(non_beginners) >= 1)

    # Every target block must contain a qualifying archer.
    for s in range(ns):
        letters = (
            ["A", "B"] if details[s] == "Single"
            else ["A", "B", "C", "D"]
        )

        for t in range(targets[s]):
            qualifying = [
                x[(a, s, t, letter)]
                for a, row in df.iterrows()
                if is_special(row)
                for letter in letters
            ]

            if not qualifying:
                raise ValueError(
                    "No qualifying archers exist for the "
                    "special target-block rule."
                )

            model.Add(sum(qualifying) >= 1)

    # Explicit session preferences are hard constraints.
    # College defaults remain soft preferences below them.
    preference_score = []
    preference_score_bound = 0

    for a, row in df.iterrows():
        prefs = parse_session_preferences(row["Session Preference"])

        letters_by_session = {
            s: (
                ["A", "B"] if details[s] == "Single"
                else ["A", "B", "C", "D"]
            )
            for s in range(ns)
        }

        if prefs:
            allowed_sessions = {p - 1 for p in prefs}

            for s in range(ns):
                if s not in allowed_sessions:
                    for t in range(targets[s]):
                        for letter in letters_by_session[s]:
                            model.Add(x[(a, s, t, letter)] == 0)

        else:
            # College preferences apply only when no explicit preference
            # has been supplied.
            wanted = college_default(row, cfg)

            if wanted is not None and 1 <= wanted <= ns:
                s = wanted - 1

                preference_score.extend(
                    10_000 * x[(a, s, t, letter)]
                    for t in range(targets[s])
                    for letter in letters_by_session[s]
                )
                preference_score_bound += (
                    10_000
                    * targets[s]
                    * len(letters_by_session[s])
                )

    
    # Minimal-change objective.
    # Existing allocations are soft preferences, never hard constraints.
    # Match by membership number only when that identifier is unique in
    # both draws. Duplicated identifiers are skipped rather than blocking
    # scheduling; their allocations can still be solved normally.
    preservation_score = []

    if existing_draw is not None and not existing_draw.empty:
        required_columns = {
            "Membership Number", "Session", "Target", "Position",
        }
        missing = required_columns - set(existing_draw.columns)

        if missing:
            raise ValueError(
                "Cannot minimize schedule changes because the existing "
                "draw is missing columns: "
                + ", ".join(sorted(missing))
            )

        old_members = (
            existing_draw["Membership Number"]
            .fillna("")
            .astype(str)
            .str.strip()
        )
        new_members = (
            df["Membership Number"]
            .fillna("")
            .astype(str)
            .str.strip()
        )

        old_counts = old_members[old_members.ne("")].value_counts()
        new_counts = new_members[new_members.ne("")].value_counts()

        old_allocations = {}
        for index, old in existing_draw.iterrows():
            member = str(old["Membership Number"]).strip()

            if (
                not member
                or old_counts.get(member, 0) != 1
                or new_counts.get(member, 0) != 1
            ):
                continue

            old_allocations[member] = (
                int(old["Session"]),
                int(old["Target"]),
                str(old["Position"]).strip().upper(),
            )

        for a, row in df.iterrows():
            member = str(row["Membership Number"]).strip()
            old_slot = old_allocations.get(member)

            if old_slot is None:
                continue

            old_session, old_target, old_position = old_slot
            key = (
                a,
                old_session - 1,
                old_target - 1,
                old_position,
            )

            # If the previous position no longer exists, or the archer's
            # new face type makes it invalid, don't reward that position.
            if key in x:
                preservation_score.append(x[key])

    # Hard session preferences are already enforced above.
    # Face compatibility is also enforced by the model constraints.
    # Therefore preservation can only choose among otherwise valid draws.
    preservation_weight = 1000
    if preservation_score:
        # One additional preserved slot outweighs every possible soft score.
        secondary_score_bound = (
            10_000_000 * len(club_penalties)
            + preference_score_bound
            + 1000 * clustering_score_bound
            + cluster_order_score_bound
        )
        preservation_weight = secondary_score_bound + 1

    model.Maximize(
        preservation_weight * sum(preservation_score)
        + sum(preference_score)
        - 10_000_000 * sum(club_penalties)
        + 1000 * sum(clustering_score)
        + sum(cluster_order_score)
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(
        cfg["solver_time_limit_seconds"]
    )
    solver.parameters.num_search_workers = 8

    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise ValueError(
            "No valid draw found. Review target capacity, face types, "
            "session restrictions and target-block requirements."
        )

    result = []

    for (a, s, t, letter), var in x.items():
        if solver.Value(var):
            row = df.iloc[a]

            result.append({
                "Session": s + 1,
                "Target": t + 1,
                "Position": letter,
                "Archer": row["_name"],
                "First Name": row["First Name"],
                "Last Name": row["Last Name"],
                "College": row["College"],
                "Bow Type": row["Bow Type"],
                "Target Face": (
                    "Vegas"
                    if vegas_mode
                    and str(face_overrides.get(a, row["_face"])).lower()
                    in {"3s", "vegas"}
                    else face_overrides.get(a, row["_face"])
                ),
                "Category": row["Category"],
                "Gender": row["Gender"],
                "Which Days": row["Which Days"],
                "Membership Number": row["Membership Number"],
                "Category Code": row["_code"],
                "Session Preference": row["Session Preference"],
                "Head-to-Head Eligible": hth_eligible(row),
            })

    draw = pd.DataFrame(result).sort_values(
        ["Session", "Target", "Position"]
    ).reset_index(drop=True)

    return draw, solver.StatusName(status), capacities


def head_to_heads(df):
    eligible = df[df.apply(hth_eligible, axis=1)].copy()
    counts = eligible["_code"].value_counts().to_dict()

    groups = []
    consumed = set()

    for code in sorted(VALID_HTH):
        if code in consumed:
            continue

        mate = code[:-1] + (
            "F" if code.endswith("O") else "O"
        )

        if mate in VALID_HTH and mate not in consumed:
            a = counts.get(code, 0)
            b = counts.get(mate, 0)

            if a < 4 or b < 4:
                groups.append((
                    code[:-1] + " (O/F merged)",
                    a + b,
                ))
                consumed.update([code, mate])
                continue

        groups.append((code, counts.get(code, 0)))
        consumed.add(code)

    report = []

    for label, entrants in groups:
        if entrants == 0:
            continue

        rounds = (
            math.ceil(math.log2(entrants))
            if entrants > 1 else 0
        )
        bracket_matches = max(0, entrants - 1)
        bronze = 1 if entrants >= 3 else 0

        # Knockout round structure, including byes.
        stage_matches = []
        if rounds:
            bracket_size = 2 ** rounds
            byes = bracket_size - entrants
            first_round = (entrants - byes) // 2

            stage_matches.append(first_round)

            remaining_winners = first_round
            for _ in range(1, rounds):
                remaining_winners = math.ceil(
                    remaining_winners / 2
                )
                stage_matches.append(remaining_winners)

        report.append({
            "Category": label,
            "Entrants": entrants,
            "Elimination Rounds": rounds,
            "Bracket Matches": bracket_matches,
            "Bronze Match": "Yes" if bronze else "No",
            "Total Matches Including Bronze": (
                bracket_matches + bronze
            ),
            "Matches By Round": " → ".join(
                map(str, stage_matches)
            ),
        })

    return pd.DataFrame(report)


def parse_allocation(value):
    """Parse an allocation such as 1.14A into (session, target, position)."""
    import re
    match = re.fullmatch(r"\s*(\d+)\.(\d+)([ABCD])\s*", str(value).upper())
    if not match:
        raise ValueError(f"Invalid allocation {value!r}; use a format such as 1.14A.")
    return int(match.group(1)), int(match.group(2)), match.group(3)


def allocation_label(row):
    return f"{int(row['Session'])}.{int(row['Target'])}{row['Position']}"


def face_pair_position(position):
    return "A" if position in ("A", "C") else "B"


def refresh_summary(draw):
    if draw.empty:
        return pd.DataFrame(columns=["Session", "Archers", "Targets_Used"])
    return (
        draw.groupby("Session")
        .agg(Archers=("Archer", "count"), Targets_Used=("Target", "nunique"))
        .reset_index()
    )


def incompatible_faces(draw):
    """Return (session, target) pairs whose physical face pair is inconsistent."""
    conflicts = set()
    if draw.empty:
        return conflicts
    for (session, target), group in draw.groupby(["Session", "Target"]):
        for positions in (("A", "C"), ("B", "D")):
            face_group = group[group["Position"].isin(positions)]
            compatible_faces = face_group["Target Face"].replace(
                {"Vegas": "40", "vegas": "40"}
            )
            if compatible_faces.nunique() > 1:
                conflicts.add((int(session), int(target)))
    return conflicts


def class_code_to_fields(code, current_row):
    """Translate a displayed class code back into persistent roster fields."""
    code = str(code).strip().upper()
    valid_codes = {
        "BBO", "BBF", "BIO", "BIF", "BAO", "BAF", "BG", "BS",
        "RBO", "RBF", "RIO", "RIF", "RAO", "RAF", "RG", "RS",
        "CO", "CF", "CG", "CS",
    }
    if code not in valid_codes:
        raise ValueError(f"Unrecognised class code {code!r}.")

    prefix = code[0]
    bow = {"B": "barebow", "R": "recurve", "C": "compound"}[prefix]
    if prefix == "C":
        if code == "CG":
            category, gender = "guest", current_row["Gender"]
        elif code == "CS":
            category, gender = "senior league", current_row["Gender"]
        else:
            category = current_row["Category"]
            if category in ("guest", "senior league"):
                category = "advanced"
            gender = "female" if code == "CF" else "open"
        return {"Bow Type": bow, "Category": category, "Gender": gender}

    ability = code[1]
    category = {
        "B": "beginner", "I": "intermediate", "A": "advanced",
        "G": "guest", "S": "senior league",
    }[ability]
    if ability in ("G", "S"):
        gender = current_row["Gender"]
    else:
        gender = "female" if code[2] == "F" else "open"
    return {"Bow Type": bow, "Category": category, "Gender": gender}


def target_face_swaps(
    draw,
    allocations,
    targets,
    details,
    df,
    cfg,
    campanile_mode=True,
    clustering_mode=False,
    vegas_mode=False,
):
    """Try both face-swap directions, then each independently.

    Attempt order:
      1. All requested changes together.
      2. Only 40 -> 3s changes.
      3. Only 3s -> 40 changes.

    Each attempt starts from the original draw. The first feasible
    full schedule is returned; if none succeeds, the original draw
    is left unchanged and an error is raised.
    """
    original_draw = draw.copy()
    requested = []
    seen_locations = set()

    for allocation in allocations:
        location = parse_allocation(allocation)

        if location in seen_locations:
            raise ValueError(
                f"Allocation {allocation} was listed more than once."
            )
        seen_locations.add(location)

        session, target, position = location
        matches = original_draw.index[
            (original_draw["Session"] == session)
            & (original_draw["Target"] == target)
            & (original_draw["Position"] == position)
        ].tolist()

        if len(matches) != 1:
            raise ValueError(
                f"No uniquely allocated archer found at {allocation}."
            )

        requested.append(matches[0])

    if not requested:
        raise ValueError("Select at least one archer to swap.")

    # Classify the requested changes using the original draw.
    changes = {"40_to_3s": [], "3s_to_40": []}

    for idx in requested:
        face = str(original_draw.at[idx, "Target Face"]).strip()

        if face.lower() in {"3s", "vegas"}:
            changes["3s_to_40"].append(idx)
        elif face == "40":
            changes["40_to_3s"].append(idx)
        else:
            raise ValueError(
                f"Unexpected target face type {face!r}."
            )

    attempts = [
        ("both", ["40_to_3s", "3s_to_40"]),
        ("40_to_3s", ["40_to_3s"]),
        ("3s_to_40", ["3s_to_40"]),
    ]

    failures = []

    for attempt_name, directions in attempts:
        # Always start with the original allocation and face assignments.
        trial_draw = original_draw.copy()
        overridden_indices = set()

        for direction in directions:
            destination_face = (
                "3s" if direction == "40_to_3s" else "40"
            )

            for idx in changes[direction]:
                trial_draw.at[idx, "Target Face"] = destination_face
                overridden_indices.add(idx)

        if not overridden_indices:
            continue

        # Map the original draw rows to normalized roster rows by their
        # current allocation identity. This avoids membership-number
        # collisions when an archer has been duplicated.
        face_overrides = {}

        for idx in overridden_indices:
            allocation = original_draw.loc[idx]
            matches = df.index[
                df["_name"].astype(str).eq(
                    str(allocation["Archer"])
                )
                & df["Membership Number"].astype(str).eq(
                    str(allocation["Membership Number"])
                )
            ].tolist()

            if len(matches) != 1:
                raise ValueError(
                    "Cannot uniquely match the selected archer to "
                    "the solver roster. Use a stable per-archer row "
                    "identifier to support duplicate names and IDs."
                )

            face_overrides[matches[0]] = str(
                trial_draw.at[idx, "Target Face"]
            )

        try:
            new_draw, status, _ = solve_schedule(
                df,
                targets,
                details,
                cfg,
                campanile_mode=campanile_mode,
                existing_draw=trial_draw,
                face_overrides=face_overrides,
                clustering_mode=clustering_mode,
                vegas_mode=vegas_mode,
            )

            # The first feasible full schedule wins.
            return new_draw, failures

        except ValueError as exc:
            failures.append(
                f"{attempt_name} attempt failed: {exc}"
            )

    raise ValueError(
        "No valid schedule could accommodate the requested face changes. "
        + " | ".join(failures)
    )

def workbook_bytes(draw, hth, summary):
    output = io.BytesIO()

    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        draw.to_excel(
            writer, index=False, sheet_name="Shooting List"
        )
        hth.to_excel(
            writer, index=False, sheet_name="Head to Heads"
        )
        summary.to_excel(
            writer, index=False, sheet_name="Session Summary"
        )

    output.seek(0)
    return output.getvalue()



def ianseo_import_dataframe(archers, cfg, draw):
    """Build the 21 ordered, headerless IANSEO List Load columns."""
    normalized = normalize_headers(archers[REQUIRED].copy())
    short_names = cfg["college_short_names"]

    columns = [
        "Bib",
        "Session",
        "Division",
        "Class",
        "Target",
        "Individual - Division/Class",
        "Team - Division/Class",
        "Ind. Events",
        "Team Events",
        "Mixed Team Events",
        "Family Name",
        "Name",
        "Gender",
        "Country",
        "Country Name",
        "Date of Birth",
        "Subclass",
        "Country 2",
        "Country Name 2",
        "Country 3",
        "Country Name 3",
    ]

    # Build a membership-number lookup from the generated shooting draw.

    allocation_lookup = {}
    if not draw.empty:
        for _, allocation in draw.iterrows():
            member = str(allocation["Membership Number"]).strip()
            if not member:
                continue

            archer_name = " ".join(
                str(allocation["Archer"]).strip().split()
            ).casefold()

            allocation_data = {
                "Session": int(allocation["Session"]),
                "Target": int(allocation["Target"]),
                "Position": str(allocation["Position"]).strip().upper(),
                "Archer": archer_name,
            }

            if member in allocation_lookup:
                existing = allocation_lookup[member]

                if existing["Archer"] != archer_name:
                    raise ValueError(
                        f"Multiple shooting allocations found for membership "
                        f"number {member!r}, but the archer names do not match: "
                        f"{existing['Archer']!r} and {archer_name!r}."
                    )

                # Same archer in another session is intentional.
                # Keep the first allocation for backward compatibility.
                continue

            allocation_lookup[member] = allocation_data

    rows = []

    for _, archer in normalized.iterrows():
        code = str(archer["_code"]).strip().upper()

        if not code or code[0] not in {"B", "C", "R"}:
            raise ValueError(
                f"Cannot export {archer['_name']}: "
                f"invalid category code {code!r}."
            )

        bib = str(archer["Membership Number"]).strip()
        if not bib:
            raise ValueError(
                f"Cannot export {archer['_name']}: membership number is blank."
            )

        allocation = allocation_lookup.get(bib)
        if allocation is None:
            raise ValueError(
                f"Cannot export {archer['_name']}: "
                "no shooting allocation was found."
            )

        college = str(archer["College"]).strip().upper()
        if college not in short_names or not short_names[college]:
            raise ValueError(
                f"No IANSEO short name configured for college {college!r}. "
                "Add it to college_short_names in config.json."
            )

        # Preserve the existing event eligibility rule.
        competes_sunday = archer["Which Days"] == "both days"
        event_entry = "1" if competes_sunday else ""

        rows.append({
            "Bib": bib,
            "Session": str(allocation["Session"]),
            "Division": code[0],
            "Class": code[1:],
            "Target": f"{allocation['Target']}{allocation['Position']}",
            "Individual - Division/Class": "1",
            "Team - Division/Class": "1",
            "Ind. Events": event_entry,
            "Team Events": event_entry,
            "Mixed Team Events": event_entry,
            "Family Name": archer["Last Name"],
            "Name": archer["First Name"],
            "Gender": "U",
            "Country": college,
            "Country Name": short_names[college],
            "Date of Birth": "",
            "Subclass": "",
            "Country 2": "",
            "Country Name 2": "",
            "Country 3": "",
            "Country Name 3": "",
        })

    return pd.DataFrame(rows, columns=columns)

def ianseo_import_xlsx_bytes(participants):
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        # IANSEO expects positional data rows, not a header row to import as an athlete.
        participants.to_excel(
            writer, index=False, header=False, sheet_name="List Load"
        )
    output.seek(0)
    return output.getvalue()

IANSEO_COLUMNS = [
    "Bib", "Session", "Division", "Class", "Target",
    "Individual - Division/Class", "Team - Division/Class",
    "Ind. Events", "Team Events", "Mixed Team Events",
    "Family Name", "Name", "Gender", "Country", "Country Name",
    "Date of Birth", "Subclass", "Country 2", "Country Name 2",
    "Country 3", "Country Name 3",
]

def _import_key(value):
    import re
    return re.sub(r"[^a-z0-9]+", "", str(value).strip().lower())


def _find_import_column(df, aliases):
    """Return one matching column, or fail if aliases match ambiguously."""
    wanted = {_import_key(alias) for alias in aliases}
    matches = [
        col for col in df.columns
        if _import_key(col) in wanted
    ]
    if len(matches) > 1:
        raise ValueError(
            f"Ambiguous columns for {aliases[0]}: {matches}"
        )
    return matches[0] if matches else None


def _looks_like_ianseo_headerless(df):
    """Identify this app's 21-column, headerless IANSEO export."""
    if len(df.columns) != 21 or df.empty:
        return False

    first = str(df.iloc[0, 0]).strip()
    third = str(df.iloc[0, 2]).strip().upper()
    fourth = str(df.iloc[0, 3]).strip().upper()

    return (
        bool(first)
        and third in {"B", "C", "R"}
        and fourth in {
            "BO", "BF", "IO", "IF", "AO", "AF",
            "G", "S", "O", "F",
        }
    )

def render_duplicate_archer_ui(st, draw):
    """Duplicate an archer's allocation into another session."""
    with st.expander("Duplicate archer into another session"):
        _render_duplicate_archer_form(st, draw)


def _render_duplicate_archer_form(st, draw):
    required = {
        "Session", "Target", "Position", "Membership Number",
    }
    missing = required - set(draw.columns)

    if missing:
        st.error(
            "Cannot duplicate an archer because the draw is missing "
            f"required columns: {', '.join(sorted(missing))}"
        )
        return

    if draw.empty:
        st.info("Generate or import a schedule first.")
        return

    sessions = sorted(
        int(value)
        for value in draw["Session"].dropna().unique()
    )

    working_draw = draw.reset_index(drop=True)

    def allocation_label(row):
        return (
            f"{row.get('Archer', 'Unknown')} "
            f"({row['Membership Number']}) — "
            f"{int(row['Session'])}."
            f"{int(row['Target'])}{row['Position']}"
        )

    source_options = {
        index: allocation_label(row)
        for index, row in working_draw.iterrows()
    }

    with st.form("duplicate_archer_form"):
        source_index = st.selectbox(
            "Archer allocation to duplicate",
            options=list(source_options),
            format_func=lambda index: source_options[index],
            key="duplicate_source_allocation",
        )

        source_row = working_draw.iloc[source_index]
        source_session = int(source_row["Session"])

        destination_sessions = [
            session for session in sessions
            if session != source_session
        ]

        if not destination_sessions:
            st.warning("At least two sessions are required.")
            st.form_submit_button(
                "Duplicate archer",
                disabled=True,
            )
            return

        destination = st.selectbox(
            "Destination session",
            options=destination_sessions,
            key="duplicate_destination_session",
        )

        duplicate_submit = st.form_submit_button(
            "Duplicate archer",
            type="primary",
        )

    if not duplicate_submit:
        return

    try:
        current = st.session_state["draw"].copy()

        source_matches = current[
            current["Session"].eq(source_row["Session"])
            & current["Target"].eq(source_row["Target"])
            & current["Position"].astype(str).str.upper().eq(
                str(source_row["Position"]).upper()
            )
            & current["Membership Number"].astype(str).eq(
                str(source_row["Membership Number"])
            )
        ]

        if len(source_matches) != 1:
            raise ValueError(
                "The source allocation is no longer unique. "
                "Refresh the page and try again."
            )

        source = source_matches.iloc[0].copy()
        member = str(source["Membership Number"]).strip()

        if (
            current["Session"].eq(destination)
            & current["Membership Number"].astype(str).eq(member)
        ).any():
            raise ValueError(
                f"This archer already has an allocation in session "
                f"{destination}."
            )

        # Find a vacant position in the destination session, respecting face types.
        configured_targets = st.session_state.get("last_targets", [])
        configured_details = st.session_state.get("last_details", [])
        vegas_mode = st.session_state.get("vegas_mode", False)

        if destination <= len(configured_targets):
            target_limit = int(configured_targets[destination - 1])
            detail = configured_details[destination - 1]
            positions = (
                ["A", "B", "C", "D"]
                if detail == "Double"
                else ["A", "B"]
            )
        else:
            target_limit = max(
                [int(x) for x in current["Target"].dropna()] + [1]
            )
            positions = ["A", "B", "C", "D"]

        destination_draw = current[
            current["Session"].eq(destination)
        ].copy()

        paired_position = {
            "A": "C",
            "C": "A",
            "B": "D",
            "D": "B",
        }

        def normalise_face(value):
            return str(value or "").strip().lower()

        def valid_target_faces(rows):
            """Check the standard A/C and B/D target-face rules."""
            if rows.empty:
                return True

            faces = {}
            for _, row in rows.iterrows():
                pos = str(row["Position"]).strip().upper()
                face = normalise_face(row["Target Face"])
                faces[pos] = face

            # A/C and B/D must each use a consistent face when both
            # positions in a pair are occupied.
            for left, right in (("A", "C"), ("B", "D")):
                if (
                    left in faces
                    and right in faces
                    and faces[left] != faces[right]
                ):
                    return False

            # When both face types are present, A/C must be 3s and
            # B/D must be 40.
            face_types = set(faces.values())
            has_3s = "3s" in face_types
            has_40 = "40" in face_types

            if has_3s and has_40:
                for pos in ("A", "C"):
                    if pos in faces and faces[pos] != "3s":
                        return False
                for pos in ("B", "D"):
                    if pos in faces and faces[pos] != "40":
                        return False

            return True


        def target_rows(draw, target_number):
            return draw[
                draw["Target"].eq(target_number)
            ]


        def position_is_occupied(draw, target_number, pos):
            return (
                draw["Target"].eq(target_number)
                & draw["Position"].astype(str).str.strip().str.upper().eq(pos)
            ).any()


        def compatible_vacancy(draw, target_number, pos, required_face):
            """Check a vacant position against its paired position."""
            if position_is_occupied(draw, target_number, pos):
                return False

            pair = paired_position[pos]
            partner_rows = target_rows(draw, target_number)
            partner_rows = partner_rows[
                partner_rows["Position"]
                .astype(str).str.strip().str.upper().eq(pair)
            ]

            if not partner_rows.empty:
                partner_faces = {
                    normalise_face(face)
                    for face in partner_rows["Target Face"]
                }
                if partner_faces != {required_face}:
                    return False

            return valid_target_faces(target_rows(draw, target_number))


        # Determine the face required by the new guest, not necessarily
        # the face of the original archer before changing their category.
        prospective_archer = source.copy()
        prospective_archer["Category"] = "guest"
        required_face = normalise_face(target_face(prospective_archer))

        if vegas_mode and required_face == "3s":
            required_face = "vegas"

        occupied = {
            (
                int(row["Target"]),
                str(row["Position"]).strip().upper(),
            )
            for _, row in destination_draw.iterrows()
        }

        chosen = None

        # First pass: find a directly compatible vacancy.
        for target_number in range(1, target_limit + 1):
            for pos in positions:
                if vegas_mode:
                    if (target_number, pos) not in occupied:
                        chosen = (target_number, pos)
                        break
                elif compatible_vacancy(
                    destination_draw, target_number, pos, required_face
                ):
                    chosen = (target_number, pos)
                    break

            if chosen is not None:
                break

        # Second pass: if necessary, move one archer to free a compatible
        # pair. Never change the moved archer's Target Face.
        if chosen is None and not vegas_mode:
            for target_number in range(1, target_limit + 1):
                for pos in positions:
                    if position_is_occupied(destination_draw, target_number, pos):
                        continue

                    pair = paired_position[pos]
                    partner_rows = target_rows(destination_draw, target_number)
                    partner_rows = partner_rows[
                        partner_rows["Position"]
                        .astype(str).str.strip().str.upper().eq(pair)
                    ]

                    # Direct placement already handles empty or compatible
                    # partners, so only consider an incompatible occupied pair.
                    if partner_rows.empty:
                        continue

                    if all(
                        normalise_face(face) == required_face
                        for face in partner_rows["Target Face"]
                    ):
                        continue

                    # Try moving the paired archer to another vacant position.
                    for move_index, archer in partner_rows.iterrows():
                        original_face = archer["Target Face"]

                        for new_target in range(1, target_limit + 1):
                            if new_target == target_number:
                                continue

                            for new_pos in positions:
                                if position_is_occupied(
                                    destination_draw, new_target, new_pos
                                ):
                                    continue

                                # Work on a temporary draw so failed moves
                                # never modify the real allocation.
                                trial = destination_draw.copy()

                                trial.loc[move_index, "Target"] = new_target
                                trial.loc[move_index, "Position"] = new_pos

                                # Explicitly preserve the archer's original face.
                                trial.loc[move_index, "Target Face"] = original_face

                                old_target_rows = target_rows(
                                    trial, target_number
                                )
                                new_target_rows = target_rows(trial, new_target)

                                if not valid_target_faces(old_target_rows):
                                    continue
                                if not valid_target_faces(new_target_rows):
                                    continue

                                # Ensure the original vacancy is now compatible.
                                if not compatible_vacancy(
                                    trial, target_number, pos, required_face
                                ):
                                    continue

                                # Commit the move only after all checks pass.
                                current.loc[move_index, "Target"] = new_target
                                current.loc[move_index, "Position"] = new_pos
                                current.loc[move_index, "Target Face"] = original_face

                                destination_draw = current[
                                    current["Session"].eq(destination)
                                ].copy()

                                chosen = (target_number, pos)
                                break

                            if chosen is not None:
                                break

                        if chosen is not None:
                            break

                    if chosen is not None:
                        break

                if chosen is not None:
                    break

        if chosen is None:
            raise ValueError(
                f"Session {destination} has no vacant position compatible "
                f"with face type {required_face!r}. "
                "No valid single-archer rearrangement was found. "
                "Increase capacity or adjust the draw."
            )

        target, position = chosen


        # Generate an independent membership ID for the duplicate.
        # The original archer's ID and allocation remain unchanged.
        roster = st.session_state["archers"].copy()
        existing_ids = set(
            roster["Membership Number"].astype(str).str.strip()
        )
        existing_ids.update(
            current["Membership Number"].astype(str).str.strip()
        )

        suffix = 1
        duplicate_member = f"{member}-DUP{suffix}"

        while duplicate_member in existing_ids:
            suffix += 1
            duplicate_member = f"{member}-DUP{suffix}"

        # Copy the roster record, if available, so the duplicate remains
        # editable and independently identifiable.
        roster_matches = roster[
            roster["Membership Number"].astype(str).str.strip().eq(member)
        ]

        if len(roster_matches) != 1:
            raise ValueError(
                f"Expected exactly one roster record for membership "
                f"{member!r}; found {len(roster_matches)}."
            )

        duplicate_roster = roster_matches.iloc[0].copy()
        duplicate_roster["Membership Number"] = duplicate_member

        if "Category" in duplicate_roster.index:
            duplicate_roster["Category"] = "guest"

        updated_roster = pd.concat(
            [roster, duplicate_roster.to_frame().T],
            ignore_index=True,
        )

        # Duplicate the allocation, modifying only the new copy.
        duplicate = source.copy()
        duplicate["Session"] = int(destination)
        duplicate["Session Preference"] = int(destination)
        duplicate["Target"] = int(target)
        duplicate["Position"] = position
        duplicate["Membership Number"] = duplicate_member
        duplicate["Target Face"] = target_face(duplicate)

        if "Category" in duplicate.index:
            duplicate["Category"] = "guest"

        if "Category Code" in duplicate.index:
            bow_type = str(source.get("Bow Type", "") or "").strip()
            duplicate["Category Code"] = f"{bow_type[0].upper()}G" if bow_type else "G"

        if "Head-to-Head Eligible" in duplicate.index:
            duplicate["Head-to-Head Eligible"] = False

        #Lock source in place to prevent a move which places it in the same place as duplicate
        source_member = str(source["Membership Number"])

        current.loc[
            current["Membership Number"].astype(str).eq(source_member),
            "Session Preference",
        ] = str(int(source["Session"]))

        # Ensure every H2H category is zero for the duplicate, if the
        # draw stores explicit category-specific scoring columns.
        for column in duplicate.index:
            normalized_column = str(column).strip().lower()
            if (
                "head-to-head" in normalized_column
                or "head to head" in normalized_column
                or normalized_column.startswith("hth ")
            ):
                duplicate[column] = 0

            updated_draw = pd.concat(
                [current, duplicate.to_frame().T],
                ignore_index=True,
            )

        updated_draw["Session"] = updated_draw["Session"].astype(int)
        updated_draw["Target"] = updated_draw["Target"].astype(int)

        if updated_draw.duplicated(
            ["Session", "Target", "Position"]
        ).any():
            raise ValueError(
                "The new allocation conflicts with an existing archer."
            )

        updated_draw = updated_draw.sort_values(
            ["Session", "Target", "Position"]
        ).reset_index(drop=True)

        # Commit state only after all validation succeeds.
        st.session_state["archers"] = updated_roster
        st.session_state["draw"] = updated_draw

        normalized = normalize_headers(
            updated_roster[REQUIRED]
        )
        st.session_state["hth"] = head_to_heads(normalized)
        st.session_state["summary"] = refresh_summary(updated_draw)

        st.session_state["draw_notice"] = (
            f"Duplicated {source.get('Archer', member)} into "
            f"session {destination}, target {target}{position}. "
            f"The new copy is a Guest with membership ID "
            f"{duplicate_member} and is excluded from head-to-head "
            "eligibility. The original remains unchanged."
        )
        st.session_state["draw_notice_is_warning"] = False

        st.rerun()

    except Exception as exc:
        st.error(f"Could not duplicate archer: {exc}")

def valid_target_faces(rows, vegas_mode=False):
    """Validate face assignments on a single target."""
    if vegas_mode:
        return True

    positions = {
        str(row["Position"]).strip().upper(): str(
            row["Target Face"]
        ).strip().lower()
        for _, row in rows.iterrows()
    }

    # Each paired position must share its face type.
    for left, right in (("A", "C"), ("B", "D")):
        if left in positions and right in positions:
            if positions[left] != positions[right]:
                return False

    # If both standard face types are present, they must occupy
    # the correct position pairs.
    faces = set(positions.values())
    if "3s" in faces and "40" in faces:
        for pos in ("A", "C"):
            if pos in positions and positions[pos] != "3s":
                return False
        for pos in ("B", "D"):
            if pos in positions and positions[pos] != "40":
                return False

    return True

def swap_target_block_numbers(draw, swap_spec):
    """Swap target numbers globally or within a specified session.

    Formats:
        '8-9'      Swap targets 8 and 9 in every session.
        '1.8-9'    Swap targets 8 and 9 in session 1.
        '2.6 - 12' Swap targets 6 and 12 in session 2.

    Does not call the solver or change sessions, positions, or faces.
    """
    import re

    match = re.fullmatch(
        r"\s*(?:(\d+)\s*\.\s*)?(\d+)\s*-\s*(\d+)\s*",
        str(swap_spec),
    )
    if not match:
        raise ValueError(
            "Enter targets as 8-9, or specify a session as 1.8-9."
        )

    session_text, first_text, second_text = match.groups()
    session = int(session_text) if session_text else None
    first, second = int(first_text), int(second_text)

    if session is not None and session < 1:
        raise ValueError("Session numbers must be positive integers.")

    if first < 1 or second < 1:
        raise ValueError("Target numbers must be positive integers.")

    if first == second:
        raise ValueError("Choose two different target numbers.")

    required = {"Session", "Target", "Position"}
    missing = required - set(draw.columns)
    if missing:
        raise ValueError(
            "Cannot swap target blocks; missing columns: "
            + ", ".join(sorted(missing))
        )

    result = draw.copy()

    if session is not None:
        if not result["Session"].eq(session).any():
            raise ValueError(
                f"Session {session} does not exist in the current draw."
            )
        scope = result["Session"].eq(session)
    else:
        scope = result.index.to_series().isin(result.index)

    first_mask = scope & result["Target"].eq(first)
    second_mask = scope & result["Target"].eq(second)

    if not first_mask.any() and not second_mask.any():
        scope_description = (
            f" in session {session}" if session is not None else ""
        )
        raise ValueError(
            f"Neither target {first} nor target {second} exists"
            f"{scope_description}."
        )

    # Swap simultaneously to avoid replacement collisions.
    original_targets = result["Target"].copy()
    result.loc[first_mask, "Target"] = second
    result.loc[second_mask, "Target"] = first

    # Verify that all columns except Target are unchanged.
    unchanged_columns = [
        column for column in draw.columns if column != "Target"
    ]
    if not result[unchanged_columns].equals(draw[unchanged_columns]):
        raise RuntimeError(
            "Unexpected change detected outside the Target column."
        )

    return result.sort_values(
        ["Session", "Target", "Position"]
    ).reset_index(drop=True)


def render_archer_class_counts(st, archers, title="Archers per class"):
    """Display populated archer class counts without changing page width."""
    classes = [
        "BBO", "BBF", "BIO", "BIF", "BAO", "BAF", "BS", "BG",
        "RBO", "RBF", "RIO", "RIF", "RAO", "RAF", "RS", "RG",
        "CO", "CF", "CS", "CG",
    ]

    if archers is None or archers.empty:
        return

    required = {"Bow Type", "Category", "Gender"}
    missing = required - set(archers.columns)

    if missing:
        st.warning(
            "Cannot display class counts: missing columns "
            + ", ".join(sorted(missing))
        )
        return

    # Build the class code using the application's existing converter.
    # This avoids guessing how descriptive category names map to codes.
    if "Category Code" in archers.columns:
        codes = (
            archers["Category Code"]
            .fillna("")
            .astype(str)
            .str.strip()
            .str.upper()
        )
    else:
        codes = archers.apply(category_code, axis=1)

    counts = codes.value_counts()
    populated = [
        {"Class": code, "Archers": int(counts.get(code, 0))}
        for code in classes
        if counts.get(code, 0) > 0
    ]

    compact_rows = []
    for offset in range(0, len(populated), 4):
        compact_row = {}
        for pair_number, item in enumerate(
            populated[offset:offset + 4], start=1
        ):
            compact_row[f"Class {pair_number}"] = item["Class"]
            compact_row[f"Archers {pair_number}"] = item["Archers"]
        compact_rows.append(compact_row)

    if not populated:
        return

    display_df = pd.DataFrame(compact_rows)

    # Keep class labels as strings and counts as nullable integers.
    for column in display_df.columns:
        if column.startswith("Class "):
            display_df[column] = display_df[column].fillna("")
        elif column.startswith("Archers "):
            display_df[column] = display_df[column].astype("Int64")

    st.subheader(title)
    st.dataframe(
        display_df,
        hide_index=True,
        width="stretch",
    )


st.set_page_config(layout="wide")

cfg = load_config();

uploaded = st.file_uploader(
    "Upload archer list (CSV, TSV, XLSX or ODS)",
    type=["csv", "tsv", "xlsx", "ods", 'tab', 'txt'],
)

if "archers" not in st.session_state:
    st.session_state["archers"] = pd.DataFrame(columns=REQUIRED)

if uploaded is not None:
    st.caption(f"Selected file: {uploaded.name}")

    import_mode = st.radio(
        "How would you like to import this file?",
        [
            "Import roster → Generate",
            "Copy existing schedule",
        ],
        key="import_mode",
        horizontal=True,
    )

    if st.button(
        "Import file",
        type="primary",
        key="import_file_button",
    ):
        try:
            raw = read_entry_file(uploaded)

            # Use the existing name-splitting logic for both import modes.
            incoming = prepare_import_roster(raw)

            # Ensure the roster has separate First Name and Last Name fields
            # before matching imported allocations.
            incoming["First Name"] = incoming["First Name"].fillna("").astype(str).str.strip()
            incoming["Last Name"] = incoming["Last Name"].fillna("").astype(str).str.strip()

            if incoming.empty:
                raise ValueError("The uploaded file contains no archers.")

            if incoming["Membership Number"].eq("").any():
                raise ValueError(
                    "Every archer must have a membership number/Bib "
                    "to import safely."
                )

            if incoming["Membership Number"].duplicated().any():
                duplicates = incoming.loc[
                    incoming["Membership Number"].duplicated(keep=False),
                    "Membership Number",
                ].unique().tolist()
                raise ValueError(
                    "Duplicate membership numbers: "
                    + ", ".join(duplicates[:10])
                )

            if import_mode == "Copy existing schedule":
                # Require valid existing allocations. Never fall back
                # to a new schedule if this import fails.
                imported_draw = restore_imported_draw(raw, incoming)
                normalized = normalize_headers(incoming)

                sessions = sorted(imported_draw["Session"].unique())
                if not sessions or sessions != list(
                    range(1, max(sessions) + 1)
                ):
                    raise ValueError(
                        "Imported sessions must be numbered consecutively "
                        "from 1."
                    )

                last_targets = []
                last_details = []

                for session in sessions:
                    session_draw = imported_draw[
                        imported_draw["Session"] == session
                    ]
                    last_targets.append(
                        int(session_draw["Target"].max())
                    )
                    last_details.append(
                        "Double"
                        if session_draw["Position"].isin(["C", "D"]).any()
                        else "Single"
                    )

                # Only update session state after all validation succeeds.
                st.session_state["archers"] = incoming[REQUIRED].copy()
                st.session_state["draw"] = imported_draw
                st.session_state["hth"] = head_to_heads(normalized)
                st.session_state["summary"] = refresh_summary(imported_draw)
                st.session_state["last_targets"] = last_targets
                st.session_state["last_details"] = last_details
                st.session_state["solver_status"] = "Imported"

                st.session_state["draw_notice"] = (
                    f"Copied {len(imported_draw)} existing allocations. "
                    "No new schedule was generated."
                )
                st.session_state["draw_notice_is_warning"] = False

            else:
                # Preserve the original roster-import/merge workflow.
                existing = st.session_state["archers"].copy()

                if existing.empty:
                    merged = incoming
                else:
                    existing = existing.set_index(
                        "Membership Number", drop=False
                    )
                    new_rows = incoming.set_index(
                        "Membership Number", drop=False
                    )

                    existing.update(new_rows)
                    merged = pd.concat([
                        existing.loc[
                            ~existing.index.isin(new_rows.index)
                        ],
                        new_rows,
                    ]).reset_index(drop=True)

                st.session_state["archers"] = (
                    merged[REQUIRED].reset_index(drop=True)
                )

                existing_draw = st.session_state.get("draw")
                keep_existing_draw = (
                    existing_draw is not None and not existing_draw.empty
                )
                if keep_existing_draw:
                    normalized = normalize_headers(
                        st.session_state["archers"]
                    )
                    st.session_state["hth"] = head_to_heads(normalized)
                else:
                    for key in (
                        "draw", "hth", "summary",
                        "last_targets", "last_details",
                    ):
                        st.session_state.pop(key, None)

                st.session_state.pop("upload_signature", None)

                st.success(
                    f"Imported {len(incoming)} rows; "
                    f"{len(merged)} archers are now in the roster. "
                    + (
                        "Existing assignments will be preserved where valid "
                        "when you generate the updated schedule."
                        if keep_existing_draw
                        else "Configure the sessions and click Generate schedule."
                    )
                )

            st.rerun()

        except Exception as exc:
            st.error(f"Import failed: {exc}")


df = normalize_headers(st.session_state["archers"]) if not st.session_state["archers"].empty else pd.DataFrame()

col_upload, col_clear = st.columns([4, 1])
with col_clear:
    if st.button("Clear all archers", type="secondary"):
        st.session_state["archers"] = pd.DataFrame(columns=REQUIRED)
        st.session_state.pop("draw", None)
        st.session_state.pop("hth", None)
        st.session_state.pop("summary", None)
        st.session_state.pop("upload_signature", None)
        st.rerun()

if not df.empty:
    st.success(f"{len(df)} archers loaded.")
    st.dataframe(
        df[REQUIRED + ["_face", "_code"]].rename(columns={
            "_face": "Target Face",
            "_code": "Head-to-Head Category",
        }),
        width='stretch',
        hide_index=True,
    )

    st.subheader("Competition setup")

    ns = st.number_input(
        "Number of sessions",
        min_value=1,
        max_value=8,
        value=2,
    )

    targets = []
    details = []

    for session_index in range(int(ns)):
        left, right = st.columns(2)
        with left:
            target_count = st.number_input(
                f"Targets in session {session_index + 1}",
                min_value=1,
                max_value=200,
                value=17,
                key=f"targets_{session_index}",
            )
            targets.append(int(target_count))
        with right:
            detail = st.selectbox(
                f"Session {session_index + 1} detail",
                ["Double", "Single"],
                key=f"detail_{session_index}",
                help="Double = four archers per target; Single = two archers per target.",
            )
            details.append(detail)

    capacities = [
        targets[session_index] * (4 if details[session_index] == "Double" else 2)
        for session_index in range(int(ns))
    ]
    st.write("Session capacities:", capacities)
    st.write("Total capacity:", sum(capacities))

    if sum(capacities) < len(df):
        st.warning("There are not enough places for every archer.")

    target_mode = st.radio(
        "Target grouping mode",
        ["Campanile", "Cluster by class", "Standard"],
        index=0,
        horizontal=True,
        key="target_grouping_mode",
        help=(
            "Campanile avoids targets made entirely of beginners. "
            "Cluster by class makes a best effort to group matching classes. "
            "These modes are mutually exclusive."
        ),
    )
    campanile_mode = target_mode == "Campanile"
    clustering_mode = target_mode == "Cluster by class"
    st.session_state["campanile_mode"] = campanile_mode
    st.session_state["clustering_mode"] = clustering_mode

    vegas_mode = st.toggle(
        "Replace all 3s faces with Vegas",
        value=False,
        key="vegas_mode",
        help=(
            "Vegas faces can be assigned to any position. A target may have "
            "zero to four Vegas archers, subject to its position capacity."
        ),
    )

    if st.button("Generate schedule", type="primary"):
        try:
            draw, solver_status, capacities = solve_schedule(
                df,
                targets,
                details,
                cfg,
                campanile_mode=campanile_mode,
                clustering_mode=clustering_mode,
                vegas_mode=vegas_mode,
                existing_draw=st.session_state.get("draw"),
            )
            hth = head_to_heads(df)
            summary = (
                draw.groupby("Session")
                .agg(Archers=("Archer", "count"), Targets_Used=("Target", "nunique"))
                .reset_index()
            )
            st.session_state["draw"] = draw
            st.session_state["hth"] = hth
            st.session_state["summary"] = summary
            st.session_state["last_targets"] = targets
            st.session_state["last_details"] = details
            st.session_state["solver_status"] = solver_status
            st.success(f"Schedule generated: {solver_status}")
        except Exception as exc:
            st.error(f"Scheduling halted: {exc}")
else:
    st.info("Upload a list to get started, or clear the current list.")

if "draw" in st.session_state:
    notice_text = st.session_state.pop("draw_notice", None)
    if notice_text:
        notice_is_warning = st.session_state.pop("draw_notice_is_warning", True)
        (st.warning if notice_is_warning else st.success)(notice_text)
    draw = st.session_state["draw"]
    hth = st.session_state["hth"]
    summary = st.session_state["summary"]

    st.subheader("Session summary")
    st.dataframe(
        summary,
        width='stretch',
        hide_index=True,
    )

    render_archer_class_counts(st, st.session_state["archers"])

    st.subheader("Shooting list")

    face_conflicts = incompatible_faces(draw)
    for session in sorted(draw["Session"].unique()):
        st.markdown(f"### Session {session}")
        subset = draw[draw["Session"] == session]
        for target in sorted(subset["Target"].unique()):
            group = subset[subset["Target"] == target]
            if (int(session), int(target)) in face_conflicts:
                st.warning(
                    f"Target {target} has incompatible face types. "
                    "Review the A/C and B/D face pairs."
                )
            else:
                st.markdown(f"**Target {target}**")
            cols = st.columns(2 if len(group) <= 2 else 4)
            for idx, (_, archer) in enumerate(group.iterrows()):
                with cols[idx % len(cols)]:
                    with st.container(border=True):
                        name_col, edit_col = st.columns([8, 1])
                        with name_col:
                            st.markdown(
                                f"**{archer['Position']} — {archer['Archer']}**"
                            )
                        with edit_col:

                            member_key = str(archer["Membership Number"])
                            allocation_key = (
                                f"archer_options_{member_key}_"
                                f"{int(archer['Session'])}_"
                                f"{int(archer['Target'])}_"
                                f"{archer['Position']}"
                            )

                            if st.button(
                                "✏️",
                                key=allocation_key,
                                help="Edit archer",
                            ):
                                st.session_state["edit_member"] = member_key
                                st.rerun()

                        st.caption(
                            f"{archer['Category Code'] or archer['Gender'].title()} · "
                            f"{archer['College']} · {archer['Bow Type']}"
                        )
                        st.caption(
                            f"Membership: {archer['Membership Number']} · "
                            f"Face: {archer['Target Face']}"
                        )

    st.subheader("Modify the draw")

    members = draw["Membership Number"].astype(str).tolist()

    if st.session_state.get("edit_member") in members:
        edit_member = st.session_state["edit_member"]
        roster = st.session_state["archers"].copy()
        edit_rows = roster.index[roster["Membership Number"].astype(str) == edit_member].tolist()
        if edit_rows:
            edit_index = edit_rows[0]
            st.markdown(f"#### Edit archer: {edit_member}")
            with st.form(f"edit_archer_form_{edit_member}"):
                edited = {}
                edit_columns = st.columns(3)
                for i, field in enumerate(REQUIRED):
                    with edit_columns[i % 3]:
                        edited[field] = st.text_input(
                            field, value=str(roster.at[edit_index, field]),
                            key=f"edit_{edit_member}_{field}",
                        )
                save_edit = st.form_submit_button("Save archer details")
            if save_edit:
                try:
                    if not edited["Membership Number"].strip():
                        raise ValueError("Membership Number cannot be blank.")
                    duplicate = (
                        roster["Membership Number"].astype(str).eq(edited["Membership Number"].strip())
                        & (roster.index != edit_index)
                    )
                    if duplicate.any():
                        raise ValueError("That membership number already belongs to another archer.")
                    for field in REQUIRED:
                        roster.at[edit_index, field] = edited[field].strip()
                    normalized = normalize_headers(roster[REQUIRED])
                    new_draw, status, _ = solve_schedule(
                        normalized, st.session_state["last_targets"],
                        st.session_state["last_details"], cfg,
                        campanile_mode=st.session_state.get("campanile_mode", True),
                        existing_draw=st.session_state["draw"].copy(),
                        clustering_mode=st.session_state.get("clustering_mode", False),
                        vegas_mode=st.session_state.get("vegas_mode", False),
                    )
                    st.session_state["archers"] = roster[REQUIRED].reset_index(drop=True)
                    st.session_state["draw"] = new_draw
                    st.session_state["hth"] = head_to_heads(normalized)
                    st.session_state["summary"] = refresh_summary(new_draw)
                    st.session_state["solver_status"] = status
                    st.session_state.pop("edit_member", None)
                    st.session_state["draw_notice"] = "Archer details saved and schedule regenerated."
                    st.session_state["draw_notice_is_warning"] = False
                    st.rerun()
                except Exception as exc:
                    st.error(f"Could not save archer details: {exc}")
            if st.button("Cancel editing", key=f"cancel_edit_{edit_member}"):
                st.session_state.pop("edit_member", None)
                st.rerun()
    labels = {
        str(r["Membership Number"]): (
            f"{r['Archer']} ({r['Membership Number']}) — "
            f"{r['Session']}.{r['Target']}{r['Position']}"
        )
        for _, r in draw.iterrows()
    }

    render_duplicate_archer_ui(st, draw)

    
    with st.expander("Delete an archer or allocation"):
        delete_mode = st.radio(
            "What would you like to delete?",
            [
                "This allocation only",
                "Archer entirely (all sessions)",
            ],
            key="delete_mode",
        )

        if delete_mode == "This allocation only":
            allocation_options = {
                (
                    str(row["Membership Number"]),
                    int(row["Session"]),
                    int(row["Target"]),
                    str(row["Position"]),
                ): (
                    f"{row['Archer']} ({row['Membership Number']}) — "
                    f"{int(row['Session'])}."
                    f"{int(row['Target'])}{row['Position']}"
                )
                for _, row in draw.iterrows()
            }

            if not allocation_options:
                st.info("There are no allocations to delete.")
            else:
                selected_allocation = st.selectbox(
                    "Allocation to delete",
                    options=list(allocation_options),
                    format_func=lambda value: allocation_options[value],
                    key="delete_allocation_selection",
                )

                if st.button(
                    "Delete allocation",
                    key="confirm_delete_allocation",
                    type="primary",
                ):
                    member, session, target, position = selected_allocation

                    current_draw = st.session_state["draw"].copy()

                    mask = (
                        current_draw["Membership Number"].astype(str).eq(member)
                        & current_draw["Session"].eq(session)
                        & current_draw["Target"].eq(target)
                        & current_draw["Position"].astype(str).eq(position)
                    )

                    if int(mask.sum()) != 1:
                        st.error(
                            "The allocation could not be uniquely identified. "
                            "Nothing was deleted."
                        )
                    else:
                        # Remove only the selected allocation initially.
                        updated_draw = (
                            current_draw.loc[~mask]
                            .reset_index(drop=True)
                        )

                        # If the archer has no allocations left, remove them
                        # from the roster as well.
                        remaining_allocations = updated_draw[
                            updated_draw["Membership Number"]
                            .astype(str).eq(member)
                        ]

                        archer_removed = remaining_allocations.empty

                        st.session_state["draw"] = updated_draw

                        if archer_removed:
                            archers = st.session_state["archers"].copy()

                            st.session_state["archers"] = (
                                archers[
                                    archers["Membership Number"]
                                    .astype(str).ne(member)
                                ].reset_index(drop=True)
                            )

                            st.session_state["hth"] = (
                                head_to_heads(
                                    normalize_headers(
                                        st.session_state["archers"]
                                    )
                                )
                                if not st.session_state["archers"].empty
                                else pd.DataFrame()
                            )

                        st.session_state["summary"] = refresh_summary(
                            st.session_state["draw"]
                        )

                        if archer_removed:
                            notice = (
                                f"Deleted allocation {session}.{target}{position} "
                                f"for membership number {member}. The archer had "
                                "no remaining allocations and was removed from "
                                "the roster."
                            )
                        else:
                            notice = (
                                f"Deleted allocation {session}.{target}{position} "
                                f"for membership number {member}. Other allocations "
                                "and the roster entry were retained."
                            )

                        st.session_state["draw_notice"] = notice
                        st.session_state["draw_notice_is_warning"] = False
                        st.rerun()

        else:
            members_with_allocations = set(
                draw["Membership Number"].astype(str)
            )

            if not members_with_allocations:
                st.info("There are no allocated archers to delete.")
            else:
                available_members = [
                    member
                    for member in members
                    if str(member) in members_with_allocations
                ]

                if not available_members:
                    st.info("There are no rostered archers with allocations.")
                else:
                    delete_member = st.selectbox(
                        "Archer to delete from all sessions",
                        available_members,
                        format_func=lambda value: labels.get(value, value),
                        key="delete_member_entirely",
                    )

                    if st.button(
                        "Delete archer and all allocations",
                        key="confirm_delete_entirely",
                        type="primary",
                    ):
                        current_draw = st.session_state["draw"].copy()
                        current_archers = st.session_state["archers"].copy()

                        st.session_state["draw"] = (
                            current_draw[
                                current_draw["Membership Number"]
                                .astype(str).ne(str(delete_member))
                            ].reset_index(drop=True)
                        )

                        st.session_state["archers"] = (
                            current_archers[
                                current_archers["Membership Number"]
                                .astype(str).ne(str(delete_member))
                            ].reset_index(drop=True)
                        )

                        st.session_state["hth"] = (
                            head_to_heads(
                                normalize_headers(st.session_state["archers"])
                            )
                            if not st.session_state["archers"].empty
                            else pd.DataFrame()
                        )

                        st.session_state["summary"] = refresh_summary(
                            st.session_state["draw"]
                        )

                        st.session_state["draw_notice"] = (
                            f"Removed membership number {delete_member} "
                            "from the roster and all session allocations."
                        )
                        st.session_state["draw_notice_is_warning"] = False
                        st.rerun()

    with st.expander("Batch session changes"):
        st.caption(
            "Enter one archer allocation and destination session per line, "
            "for example 1.14A 2. All changes are validated and scheduled together."
        )
        batch_session_text = st.text_area(
            "Allocation and destination session (one per line)",
            key="batch_session_instructions",
            placeholder="1.14A 2\n2.16B 3\n3.2C 1",
        )
        if st.button("Apply batch session changes", key="apply_batch_sessions"):
            try:
                instructions = [line.strip() for line in batch_session_text.splitlines() if line.strip()]
                if not instructions:
                    raise ValueError("Enter at least one allocation and destination session.")
                roster = st.session_state["archers"].copy()
                changes = {}
                errors = []
                for instruction in instructions:
                    parts = instruction.split()
                    if len(parts) != 2 or not parts[1].isdigit():
                        errors.append(f"{instruction}: use '1.14A 2'.")
                        continue
                    allocation, destination = parts[0], int(parts[1])
                    if destination < 1 or destination > len(st.session_state["last_targets"]):
                        errors.append(f"{instruction}: destination session is out of range.")
                        continue
                    try:
                        session_no, target_no, position = parse_allocation(allocation)
                    except ValueError as exc:
                        errors.append(str(exc))
                        continue
                    found = draw[
                        (draw["Session"] == session_no)
                        & (draw["Target"] == target_no)
                        & (draw["Position"] == position)
                    ]
                    if len(found) != 1:
                        errors.append(f"{allocation}: no uniquely allocated archer found.")
                        continue
                    member = str(
                        found.iloc[0]["Membership Number"]
                    ).strip()

                    roster_matches = roster.index[
                        roster["Membership Number"]
                        .astype(str).str.strip().eq(member)
                    ].tolist()

                    if not roster_matches:
                        errors.append(
                            f"{allocation}: could not find the archer "
                            "in the roster."
                        )
                        continue

                    if len(roster_matches) > 1:
                        errors.append(
                            f"{allocation}: membership number {member!r} "
                            "belongs to multiple roster rows. "
                            "A unique archer ID is needed to distinguish "
                            "the original from its duplicate."
                        )
                        continue

                    roster_index = roster_matches[0]

                    if roster_index in changes:
                        errors.append(
                            f"{allocation}: this archer is listed "
                            "more than once."
                        )
                        continue

                    changes[roster_index] = destination

                if errors:
                    raise ValueError("; ".join(errors))

                for roster_index, destination in changes.items():
                    roster.at[
                        roster_index, "Session Preference"
                    ] = str(destination)

                normalized = normalize_headers(roster[REQUIRED])

                new_draw, status, _ = solve_schedule(
                    normalized,
                    st.session_state["last_targets"],
                    st.session_state["last_details"],
                    cfg,
                    campanile_mode=st.session_state.get(
                        "campanile_mode", True
                    ),
                    forced_sessions=changes,
                    existing_draw=st.session_state["draw"].copy(),
                    clustering_mode=st.session_state.get("clustering_mode", False),
                    vegas_mode=st.session_state.get("vegas_mode", False),
                )
                st.session_state["archers"] = roster[REQUIRED].reset_index(drop=True)
                st.session_state["draw"] = new_draw
                st.session_state["hth"] = head_to_heads(normalized)
                st.session_state["summary"] = refresh_summary(new_draw)
                st.session_state["solver_status"] = status
                st.session_state["draw_notice"] = f"Applied {len(changes)} batch session change(s)."
                st.session_state["draw_notice_is_warning"] = False
                st.rerun()
            except Exception as exc:
                st.error(f"Could not apply batch session changes: {exc}")

    with st.expander("Swap session/target"):
        swap_member = st.selectbox(
            "Archer to move", members,
            format_func=lambda value: labels.get(value, value),
            key="swap_member",
        )
        swap_mode = st.radio(
            "Swap type", ["Generic session preference", "Swap with specific archer"],
            key="swap_mode",
        )
        if swap_mode == "Generic session preference":
            if int(ns) > 1:
                target_sessions = st.text_input(
                    "Target session(s), comma-separated (e.g. 1, 3)",
                    key="target_sessions",
                )
                if st.button("Apply session preference"):
                    try:
                        prefs = parse_session_preferences(target_sessions)
                        if not prefs or any(x < 1 or x > int(ns) for x in prefs):
                            raise ValueError(f"Enter session numbers from 1 to {int(ns)}.")
                        roster = st.session_state["archers"].copy()
                        roster.loc[
                            roster["Membership Number"].astype(str) == swap_member,
                            "Session Preference",
                        ] = ", ".join(map(str, prefs))
                        normalized = normalize_headers(roster)
                        new_draw, status, _ = solve_schedule(
                            normalized, st.session_state["last_targets"],
                            st.session_state["last_details"], cfg,
                            campanile_mode=st.session_state.get("campanile_mode", True),
                            existing_draw=st.session_state["draw"].copy(),
                            clustering_mode=st.session_state.get("clustering_mode", False),
                            vegas_mode=st.session_state.get("vegas_mode", False),
                        )
                        st.session_state["archers"] = roster
                        st.session_state["draw"] = new_draw
                        st.session_state["hth"] = head_to_heads(normalized)
                        st.session_state["summary"] = (
                            new_draw.groupby("Session")
                            .agg(Archers=("Archer", "count"), Targets_Used=("Target", "nunique"))
                            .reset_index()
                        )
                        st.session_state["solver_status"] = status
                        st.rerun()
                    except Exception as exc:
                        st.error(f"Could not apply session preference: {exc}")
            else:
                st.caption("Only one session is configured, so there is nothing to swap.")
        
        else:
            
            location_cols = ["Session", "Target", "Position"]

            # Build every valid position in the configured schedule.
            occupied = {
                (
                    int(row["Session"]),
                    int(row["Target"]),
                    str(row["Position"]).strip().upper(),
                )
                for _, row in draw.iterrows()
            }

            destinations = []

            for session, (target_count, detail) in enumerate(
                zip(
                    st.session_state["last_targets"],
                    st.session_state["last_details"],
                ),
                start=1,
            ):
                positions = (
                    ["A", "B"] if detail == "Single"
                    else ["A", "B", "C", "D"]
                )

                for target in range(1, int(target_count) + 1):
                    for position in positions:
                        location = (session, target, position)

                        if location in occupied:
                            rows = draw[
                                (draw["Session"] == session)
                                & (draw["Target"] == target)
                                & (draw["Position"] == position)
                            ]
                            row = rows.iloc[0]
                            member = str(row["Membership Number"])
                            if member == swap_member:
                                continue

                            label = (
                                f"{row['Archer']} ({member}) — "
                                f"{session}.{target}{position}"
                            )
                        else:
                            label = (
                                f"EMPTY — {session}.{target}{position}"
                            )

                        destinations.append((location, label))

            if not destinations:
                st.info("No alternative positions are available.")
            else:
                destination = st.selectbox(
                    "Swap with archer or empty position",
                    options=[item[0] for item in destinations],
                    format_func=lambda loc: next(
                        label for location, label in destinations
                        if location == loc
                    ),
                    key="swap_destination",
                )

                if st.button("Apply swap", key="apply_swap_destination"):
                    try:
                        source_rows = draw[
                            draw["Membership Number"].astype(str)
                            == swap_member
                        ]

                        if len(source_rows) != 1:
                            raise ValueError(
                                "The selected membership number is duplicated. "
                                "Allocation-specific identity is required."
                            )

                        source_idx = source_rows.index[0]
                        source = draw.loc[source_idx]
                        destination_session, destination_target, destination_position = destination

                        updated = draw.copy()

                        # If occupied, exchange positions; if empty, move.
                        destination_rows = updated[
                            (updated["Session"] == destination_session)
                            & (updated["Target"] == destination_target)
                            & (updated["Position"] == destination_position)
                        ]

                        source_location = tuple(
                            int(source[col]) if col != "Position"
                            else str(source[col]).upper()
                            for col in location_cols
                        )

                        if not destination_rows.empty:
                            destination_idx = destination_rows.index[0]
                            updated.loc[source_idx, location_cols] = destination
                            updated.loc[destination_idx, location_cols] = source_location
                        else:
                            updated.loc[source_idx, location_cols] = destination

                        conflicts = incompatible_faces(updated)
                        if (
                            destination_session,
                            destination_target,
                        ) in conflicts:
                            raise ValueError(
                                "This move creates an incompatible target-face combination."
                            )

                        updated = updated.sort_values(
                            location_cols
                        ).reset_index(drop=True)

                        st.session_state["draw"] = updated
                        st.session_state["summary"] = refresh_summary(updated)
                        st.session_state["draw_notice"] = (
                            f"Moved {source['Archer']} to "
                            f"{destination_session}.{destination_target}"
                            f"{destination_position}."
                        )
                        st.session_state["draw_notice_is_warning"] = False
                        st.rerun()

                    except Exception as exc:
                        st.error(f"Could not apply swap: {exc}")

    with st.expander("Swap target face type"):
        st.caption("Enter allocations separated by commas, e.g. 1.14A, 2.16B, 3.2C. Each successful change moves the archer to the opposite face type.")
        face_swap_text = st.text_input(
            "Allocations to switch face type", key="face_swap_allocations"
        )
        if st.button("Apply target face swaps", key="apply_face_swaps"):
            try:
                allocations = [part.strip() for part in face_swap_text.split(",") if part.strip()]
                if not allocations:
                    raise ValueError("Enter at least one allocation.")
                roster = st.session_state["archers"].copy()
                normalized = normalize_headers(roster[REQUIRED])

                new_draw, failures = target_face_swaps(
                    st.session_state["draw"],
                    allocations,
                    st.session_state["last_targets"],
                    st.session_state["last_details"],
                    normalized,
                    cfg,
                    campanile_mode=st.session_state.get(
                        "campanile_mode", True
                    ),
                    clustering_mode=st.session_state.get(
                        "clustering_mode", False
                    ),
                    vegas_mode=st.session_state.get("vegas_mode", False),
                )

                st.session_state["draw"] = new_draw
                st.session_state["summary"] = refresh_summary(new_draw)
                st.session_state["draw_notice"] = (
                    "Some face swaps could not be completed: " + "; ".join(failures)
                    if failures else "All requested target-face swaps were applied."
                )
                st.session_state["draw_notice_is_warning"] = bool(failures)
                st.rerun()
            except Exception as exc:
                st.error(f"Could not apply target-face swaps: {exc}")

    
    with st.expander("Swap target block numbers"):
        with st.form("swap_target_block_numbers_form"):
            swap_spec = st.text_input(
                "Target blocks to swap",
                placeholder="8-9",
                help=(
                    "Swaps target numbers within each session. "
                    "Sessions, positions, faces and archer details "
                    "remain unchanged."
                ),
            )

            submitted = st.form_submit_button(
                "Swap target numbers",
                type="primary",
            )

        if submitted:
            try:
                updated = swap_target_block_numbers(
                    st.session_state["draw"],
                    swap_spec,
                )

                st.session_state["draw"] = updated
                st.session_state["summary"] = refresh_summary(updated)
                st.session_state["draw_notice"] = (
                    f"Swapped target blocks {swap_spec.strip()}."
                )
                st.session_state["draw_notice_is_warning"] = False
                st.rerun()

            except ValueError as exc:
                st.error(f"Could not swap target blocks: {exc}")


    with st.expander("Swap archer class"):
        st.caption(
            "Enter one allocation and destination class per line, e.g. "
            "1.14A RBF. Class changes update the saved roster and recalculate "
            "the target face before the schedule is regenerated."
        )
        class_swap_text = st.text_area(
            "Allocation and destination class (one per line)",
            key="class_swap_instructions",
            placeholder="1.14A RBF\n2.16B BAO\n3.2C CO",
        )
        if st.button("Apply class swaps", key="apply_class_swaps"):
            try:
                instructions = [line.strip() for line in class_swap_text.splitlines() if line.strip()]
                if not instructions:
                    raise ValueError("Enter at least one allocation and destination class.")
                roster = st.session_state["archers"].copy()
                changes = {}
                errors = []
                for instruction in instructions:
                    parts = instruction.split()
                    if len(parts) != 2:
                        errors.append(f"{instruction}: use '1.14A RBF'.")
                        continue
                    allocation, new_class = parts[0], parts[1].upper()
                    try:
                        location = parse_allocation(allocation)
                    except ValueError as exc:
                        errors.append(str(exc))
                        continue
                    matches = draw[
                        (draw["Session"] == location[0])
                        & (draw["Target"] == location[1])
                        & (draw["Position"] == location[2])
                    ]
                    if len(matches) != 1:
                        errors.append(f"{allocation}: no uniquely allocated archer found.")
                        continue
                    member = str(matches.iloc[0]["Membership Number"])
                    if member in changes:
                        errors.append(f"{allocation}: this archer is listed more than once.")
                        continue
                    roster_rows = roster.index[roster["Membership Number"].astype(str) == member].tolist()
                    if len(roster_rows) != 1:
                        errors.append(f"{allocation}: could not uniquely find the archer in the roster.")
                        continue
                    try:
                        changes[member] = class_code_to_fields(new_class, roster.loc[roster_rows[0]])
                    except ValueError as exc:
                        errors.append(f"{allocation}: {exc}")
                if errors:
                    raise ValueError("; ".join(errors))

                for member, fields in changes.items():
                    row_index = roster.index[roster["Membership Number"].astype(str) == member][0]
                    for field, value in fields.items():
                        roster.at[row_index, field] = value
                
                normalized = normalize_headers(roster[REQUIRED])

                new_draw, status, _ = solve_schedule(
                    normalized,
                    st.session_state["last_targets"],
                    st.session_state["last_details"],
                    cfg,
                    campanile_mode=st.session_state.get("campanile_mode", True),
                    existing_draw=st.session_state["draw"].copy(),
                    clustering_mode=st.session_state.get("clustering_mode", False),
                    vegas_mode=st.session_state.get("vegas_mode", False),
                )

                st.session_state["archers"] = roster[REQUIRED].reset_index(drop=True)
                st.session_state["draw"] = new_draw
                st.session_state["hth"] = head_to_heads(normalized)
                st.session_state["summary"] = refresh_summary(new_draw)
                st.session_state["solver_status"] = status
                st.session_state["draw_notice"] = (
                    f"Updated {len(changes)} archer class(es), recalculated their face types, "
                    "and regenerated the schedule."
                )
                st.session_state["draw_notice_is_warning"] = False
                st.rerun()
            except Exception as exc:
                st.error(f"Could not apply class swaps: {exc}")

    st.subheader("Head-to-head analysis")

    st.caption(
        "Only archers marked Both Days (or yes/1 in a Shooting H2H column) "
        "are eligible. Guest and Senior League archers are excluded."
    )

    st.dataframe(
        hth,
        width='stretch',
        hide_index=True,
    )

    st.download_button(
        "Download Excel workbook",
        data=workbook_bytes(draw, hth, summary),
        file_name="archery_schedule.xlsx",
        mime=(
            "application/vnd.openxmlformats-officedocument."
            "spreadsheetml.sheet"
        ),
    )

    st.download_button(
        "Download shooting list CSV",
        data=draw.to_csv(index=False).encode("utf-8-sig"),
        file_name="shooting_list.csv",
        mime="text/csv",
    )

    st.subheader("IANSEO participant import")
    st.caption(
        "Copy the tab-separated rows into IANSEO List Load. The data is "
        "headerless, with the 21 columns in the order listed below. Session "
        "and fields not applicable to this event are left blank."
    )
    try:
        ianseo_participants = ianseo_import_dataframe(
            st.session_state["archers"], cfg, draw
        )
        ianseo_text = ianseo_participants.to_csv(
            sep="\t", index=False, header=False, lineterminator="\n"
        )
        st.text_area(
            "IANSEO text",
            value=ianseo_text,
            height=280,
            disabled=True,
            help="Headerless, tab-separated rows for IANSEO List Load.",
        )
        clipboard_text = (
            json.dumps(ianseo_text)
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("&", "\\u0026")
        )
        components.html(
            f"""
            <button id="copy-all" type="button" aria-label="Copy all IANSEO text"
                style="width:100%;min-height:48px;padding:12px 16px;border:1px solid #888;border-radius:6px;background:#fff;color:#222;font:600 16px sans-serif;touch-action:manipulation;">
                Copy all
            </button>
            <div id="copy-status" role="status" aria-live="polite"
                style="padding-top:4px;font:14px sans-serif;"></div>
            <script>
            const copyText = {clipboard_text};
            const copyButton = document.getElementById("copy-all");
            const copyStatus = document.getElementById("copy-status");

            async function copyAllText() {{
                try {{
                    if (navigator.clipboard && window.isSecureContext) {{
                        await navigator.clipboard.writeText(copyText);
                    }} else {{
                        throw new Error("Clipboard API unavailable");
                    }}
                }} catch (error) {{
                    const temporaryInput = document.createElement("textarea");
                    temporaryInput.value = copyText;
                    temporaryInput.setAttribute("readonly", "");
                    temporaryInput.style.position = "fixed";
                    temporaryInput.style.top = "0";
                    temporaryInput.style.left = "-9999px";
                    document.body.appendChild(temporaryInput);
                    temporaryInput.focus();
                    temporaryInput.select();
                    temporaryInput.setSelectionRange(0, copyText.length);
                    const copied = document.execCommand("copy");
                    temporaryInput.remove();
                    if (!copied) throw error;
                }}

                copyButton.textContent = "Copied";
                copyStatus.textContent = "Copied to clipboard.";
                window.setTimeout(() => {{
                    copyButton.textContent = "Copy all";
                    copyStatus.textContent = "";
                }}, 2000);
            }}

            copyButton.addEventListener("click", copyAllText);
            </script>
            """,
            height=62,
            scrolling=False,
        )
        st.download_button(
            "Download tab-separated text",
            data=ianseo_text.encode("utf-8-sig"),
            file_name="ianseo_participants.tsv",
            mime="text/tab-separated-values",
        )
        with st.expander("Preview columns and values"):
            st.dataframe(
                ianseo_participants,
                hide_index=True,
                width='stretch',
            )
    except (ValueError, KeyError) as exc:
        st.warning(f"IANSEO export is not ready: {exc}")
