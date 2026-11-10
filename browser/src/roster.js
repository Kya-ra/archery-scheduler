// Roster import and normalisation, ported from app.py. Function names in
// comments refer to their app.py counterparts.
import Papa from "papaparse";

export const REQUIRED = [
  "First Name", "Last Name", "Bow Type", "College", "Gender",
  "Category", "Membership Number", "Which Days",
  "Session Preference",
];

export const VALID_HTH = new Set([
  "BBO", "BBF", "BIO", "BIF", "BAO", "BAF",
  "RBO", "RBF", "RIO", "RIF", "RAO", "RAF", "CO", "CF",
]);

const VALID_CLASS_CODES = new Set([
  "BBO", "BBF", "BIO", "BIF", "BAO", "BAF", "BG", "BS",
  "RBO", "RBF", "RIO", "RIF", "RAO", "RAF", "RG", "RS",
  "CO", "CF", "CG", "CS",
]);

export const IANSEO_COLUMNS = [
  "Bib", "Session", "Division", "Class", "Target",
  "Individual - Division/Class", "Team - Division/Class",
  "Ind. Events", "Team Events", "Mixed Team Events",
  "Family Name", "Name", "Gender", "Country", "Country Name",
  "Date of Birth", "Subclass", "Country 2", "Country Name 2",
  "Country 3", "Country Name 3",
];

export const DRAW_COLUMNS = [
  "Session", "Target", "Position", "Archer", "First Name", "Last Name",
  "College", "Bow Type", "Target Face", "Category", "Gender", "Which Days",
  "Membership Number", "Category Code", "Session Preference",
  "Head-to-Head Eligible",
];

const ATTENDANCE_ALIASES = {
  "1": "both days", yes: "both days", y: "both days",
  true: "both days", "0": "no h2h", no: "no h2h",
  n: "no h2h", false: "no h2h",
  both: "both days", "both days": "both days",
  saturday: "saturday only", "saturday only": "saturday only",
  sunday: "sunday only", "sunday only": "sunday only",
};

export const clean = (value) => String(value ?? "").trim();
const casefold = (value) => String(value).toLowerCase();
const collapse = (value) => String(value ?? "").trim().split(/\s+/).filter(Boolean).join(" ");

// Python-style repr() for strings in error messages.
export function pyRepr(value) {
  const text = String(value);
  return text.includes("'") && !text.includes('"') ? `"${text}"` : `'${text.replace(/'/g, "\\'")}'`;
}

const isUpperToken = (part) => part === part.toUpperCase() && part !== part.toLowerCase();

// split_archer_name
export function splitArcherName(value) {
  const parts = collapse(value).split(" ").filter(Boolean);
  if (!parts.length) return ["", ""];

  // IANSEO format, e.g. "Pádraig MAC LOCHLAINN"
  for (let index = 1; index < parts.length; index += 1) {
    if (isUpperToken(parts[index]) && /\p{L}/u.test(parts[index])
      && parts.slice(0, index).some((previous) => /\p{Ll}/u.test(previous))) {
      return [parts.slice(0, index).join(" "), parts.slice(index).join(" ")];
    }
  }

  // Irish surname prefixes, e.g. "Pádraig Mac Lochlainn"
  const prefixes = new Set(["o", "ó", "ní", "ni", "níc", "nic", "mac"]);
  for (let index = 0; index < parts.length; index += 1) {
    if (prefixes.has(casefold(parts[index]))) {
      return [parts.slice(0, index).join(" "), parts.slice(index).join(" ")];
    }
  }

  if (parts.length >= 2) return [parts.slice(0, -1).join(" "), parts.at(-1)];
  return [parts[0], ""];
}

// target_face
export function targetFace(row) {
  const bow = row["Bow Type"];
  if (bow.includes("compound")) return "3s";
  if (bow.includes("recurve")) {
    return ["advanced", "guest", "senior league"].includes(row.Category)
      || ["guest", "senior league"].includes(row.Gender)
      ? "3s"
      : "40";
  }
  if (bow.includes("barebow")) return "40";
  throw new Error(`Unknown bow type for ${row._name}: ${row["Bow Type"]}`);
}

// category_code
export function categoryCode(row) {
  const gender = clean(row.Gender).toLowerCase();
  const category = clean(row.Category).toLowerCase();
  const bow = clean(row["Bow Type"]).toLowerCase();
  const prefix = bow.includes("compound") ? "C"
    : bow.includes("barebow") ? "B"
      : bow.includes("recurve") ? "R" : "";
  if (!prefix) return "";

  const special = ["guest", "senior league"].find((value) => [gender, category].includes(value));
  if (prefix === "C") {
    if (special === "guest") return "CG";
    if (special === "senior league") return "CS";
    return ["female", "f"].includes(gender) ? "CF" : "CO";
  }
  if (special === "guest") return `${prefix}G`;
  if (special === "senior league") return `${prefix}S`;
  const ability = { beginner: "B", intermediate: "I", advanced: "A" }[category] ?? "";
  if (!ability) return "";
  return prefix + ability + (["female", "f"].includes(gender) ? "F" : "O");
}

// hth_eligible
export function hthEligible(row) {
  if (row["Which Days"] !== "both days") return false;
  if (["guest", "senior league"].includes(row.Gender)) return false;
  if (["guest", "senior league"].includes(row.Category)) return false;
  return VALID_HTH.has(row._code);
}

// is_special: every target needs at least one such archer.
export function isSpecial(row) {
  return row._face === "3s"
    || ["intermediate", "advanced"].includes(row.Category)
    || ["guest", "senior league"].includes(row.Gender)
    || ["guest", "senior league"].includes(row.Category);
}

// parse_session_preferences
export function parseSessionPreferences(value) {
  const result = [];
  for (const part of String(value ?? "").split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (!/^\d+$/.test(token)) {
      throw new Error(`Invalid session preference ${pyRepr(value)}; use numbers separated by commas.`);
    }
    const number = Number(token);
    if (!result.includes(number)) result.push(number);
  }
  return result;
}

// class_code_to_fields
export function classCodeToFields(code, current) {
  const normalized = clean(code).toUpperCase();
  if (!VALID_CLASS_CODES.has(normalized)) throw new Error(`Unrecognised class code ${pyRepr(normalized)}.`);
  const prefix = normalized[0];
  const bow = { B: "barebow", R: "recurve", C: "compound" }[prefix];
  if (prefix === "C") {
    if (normalized === "CG") return { "Bow Type": bow, Category: "guest", Gender: current.Gender };
    if (normalized === "CS") return { "Bow Type": bow, Category: "senior league", Gender: current.Gender };
    const category = ["guest", "senior league"].includes(current.Category) ? "advanced" : current.Category;
    return { "Bow Type": bow, Category: category, Gender: normalized === "CF" ? "female" : "open" };
  }
  const ability = normalized[1];
  const category = {
    B: "beginner", I: "intermediate", A: "advanced", G: "guest", S: "senior league",
  }[ability];
  const gender = ["G", "S"].includes(ability)
    ? current.Gender
    : normalized[2] === "F" ? "female" : "open";
  return { "Bow Type": bow, Category: category, Gender: gender };
}

// normalize_headers: takes REQUIRED records and returns normalised archers
// with the derived _id, _name, _face and _code fields.
export function normalizeRoster(records) {
  const archers = records.map((record, index) => {
    const row = {};
    for (const field of REQUIRED) row[field] = clean(record[field]);
    row.College = row.College.toUpperCase();
    row["Bow Type"] = row["Bow Type"].toLowerCase();
    row.Gender = row.Gender.toLowerCase();
    row.Category = row.Category.toLowerCase();
    const days = row["Which Days"].toLowerCase();
    row["Which Days"] = ATTENDANCE_ALIASES[days] ?? days;
    row._id = row["Membership Number"] || `row-${index}`;
    row._name = `${row["First Name"]} ${row["Last Name"]}`;
    row._face = targetFace(row);
    row._code = categoryCode(row);
    return row;
  });
  const counts = new Map();
  for (const archer of archers) {
    const member = archer["Membership Number"];
    if (member) counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([member]) => member);
  if (duplicates.length) throw new Error(`Duplicate membership numbers: ${duplicates.join(", ")}`);
  return archers;
}

export const rosterRecord = (archer) => Object.fromEntries(REQUIRED.map((field) => [field, archer[field] ?? ""]));

// A table read from a file: original column names plus string cells.
function toTable(rows) {
  const [header = [], ...data] = rows;
  const columns = header.map((value) => String(value ?? ""));
  return {
    columns,
    data: data.map((row) => columns.map((_, index) => String(row[index] ?? ""))),
  };
}

function headerlessIanseo(rows) {
  const known = new Set(["bib", "membership number", "first name", "archer", "name"]);
  return rows.length > 0 && rows[0].length === IANSEO_COLUMNS.length
    && !known.has(clean(rows[0][0]).toLowerCase());
}

// read_entry_file. Headerless IANSEO List Load files keep their first row
// as an archer (app.py drops it for CSV/TSV input).
export async function readEntryFile(file) {
  const filename = file.name.toLowerCase();
  let rows;
  if (filename.endsWith(".xlsx") || filename.endsWith(".ods")) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: false });
  } else if ([".csv", ".tsv", ".tab", ".txt"].some((extension) => filename.endsWith(extension))) {
    const text = (await file.text()).replace(/^﻿/, "");
    const sample = text.slice(0, 16384);
    const delimiter = filename.endsWith(".tsv") || filename.endsWith(".tab")
      ? "\t"
      : (sample.split("\t").length > sample.split(",").length ? "\t" : ",");
    rows = Papa.parse(text, { delimiter, skipEmptyLines: true }).data;
  } else {
    throw new Error("Unsupported file type. Upload CSV, TSV, TAB, TXT, XLSX, or ODS.");
  }
  if (headerlessIanseo(rows)) return toTable([IANSEO_COLUMNS, ...rows]);
  return toTable(rows);
}

// _looks_like_ianseo_headerless
function looksLikeIanseoHeaderless(table) {
  if (table.columns.length !== 21 || !table.data.length) return false;
  const [first, , third, fourth] = table.data[0].map((value) => clean(value).toUpperCase());
  return Boolean(first) && ["B", "C", "R"].includes(third)
    && ["BO", "BF", "IO", "IF", "AO", "AF", "G", "S", "O", "F"].includes(fourth);
}

// prepare_import_roster: maps scheduler exports, IANSEO exports and roster
// files onto the REQUIRED fields, then normalises them.
export function prepareImportRoster(table) {
  if (!table.data.length) return [];
  let columns = table.columns.map(clean);
  if (looksLikeIanseoHeaderless({ columns, data: table.data })) columns = [...IANSEO_COLUMNS];

  const lookup = new Map();
  columns.forEach((column, index) => lookup.set(column.toLowerCase(), index));
  const findColumn = (...names) => {
    for (const name of names) {
      const index = lookup.get(name.trim().toLowerCase());
      if (index !== undefined) return index;
    }
    return null;
  };
  const source = (...names) => {
    const index = findColumn(...names);
    return table.data.map((row) => (index === null ? "" : clean(row[index])));
  };

  const aliases = {
    "First Name": ["First Name", "Given Name", "Forename"],
    "Last Name": ["Last Name", "Family Name", "Surname"],
    "Bow Type": ["Bow Type", "Bow", "Division Name"],
    College: ["College", "Club", "Country Name", "Country", "Club Name"],
    Gender: ["Gender", "Sex", "Open/Female"],
    Category: ["Category", "Skill Category", "Age Category"],
    "Membership Number": ["Membership Number", "AI Number", "Bib", "Bib Number", "Archer Number", "ID"],
    "Which Days": ["Which Days", "Which Days?", "Shooting H2H", "H2H", "Attendance"],
    "Session Preference": ["Session Preference", "Preferred Session", "Session Preference(s)"],
  };
  const mapped = Object.fromEntries(Object.entries(aliases).map(([field, names]) => [field, source(...names)]));

  const combinedColumn = findColumn("Archer", "Archer Name", "Full Name", "Name");
  const familyColumn = findColumn("Family Name", "Last Name", "Surname");
  const givenColumn = findColumn("First Name", "Given Name", "Forename");
  if (combinedColumn !== null && familyColumn === null && givenColumn === null) {
    const names = source("Archer", "Archer Name", "Full Name", "Name").map((value) =>
      (value ? splitArcherName(value).map(clean) : ["", ""]));
    mapped["First Name"] = names.map(([first]) => first);
    mapped["Last Name"] = names.map(([, last]) => last);
  }

  if (findColumn("Family Name") !== null) {
    mapped["Last Name"] = source("Family Name");
    if (findColumn("Name") !== null && givenColumn === null) mapped["First Name"] = source("Name");
  }

  if (findColumn("Division") !== null && findColumn("Class") !== null) {
    const division = source("Division").map((value) => value.toUpperCase());
    const classValue = source("Class").map((value) => value.toUpperCase());
    const bowMap = { B: "barebow", R: "recurve", C: "compound" };
    for (let index = 0; index < table.data.length; index += 1) {
      const code = division[index] + classValue[index];
      if (!mapped["Bow Type"][index]) mapped["Bow Type"][index] = bowMap[division[index]] ?? "";
      if (VALID_CLASS_CODES.has(code)) {
        const fields = classCodeToFields(code, {
          Gender: mapped.Gender[index], Category: mapped.Category[index],
        });
        if (!mapped["Bow Type"][index]) mapped["Bow Type"][index] = fields["Bow Type"];
        if (!mapped.Category[index]) mapped.Category[index] = fields.Category;
        if (!mapped.Gender[index]) mapped.Gender[index] = fields.Gender;
      } else {
        const part = classValue[index];
        if (!mapped.Category[index]) {
          if (["G", "CG", "BG", "RG"].includes(part)) mapped.Category[index] = "guest";
          else if (["S", "CS", "BS", "RS"].includes(part)) mapped.Category[index] = "senior league";
          else if (part) {
            mapped.Category[index] = { B: "beginner", I: "intermediate", A: "advanced" }[part[0]] ?? "";
          }
        }
        if (!mapped.Gender[index]) {
          if (part.endsWith("F")) mapped.Gender[index] = "female";
          else if (part.endsWith("O")) mapped.Gender[index] = "open";
        }
      }
    }
  }

  if (findColumn(...aliases["Which Days"]) === null) {
    const events = ["Ind. Events", "Team Events", "Mixed Team Events"]
      .map((name) => findColumn(name))
      .filter((index) => index !== null);
    mapped["Which Days"] = table.data.map((row) => (events.length
      ? events.some((index) => clean(row[index]) === "1") ? "both days" : "no h2h"
      : "both days"));
  }

  const records = table.data.map((_, index) =>
    Object.fromEntries(REQUIRED.map((field) => [field, mapped[field][index]])));
  return normalizeRoster(records);
}

// Validates an imported roster the way the Streamlit import button does.
export function validateImportedRoster(incoming) {
  if (!incoming.length) throw new Error("The uploaded file contains no archers.");
  if (incoming.some((archer) => archer["Membership Number"] === "")) {
    throw new Error("Every archer must have a membership number/Bib to import safely.");
  }
}

export function makeDrawRow(archer, session, target, position, face) {
  return {
    Session: session,
    Target: target,
    Position: position,
    Archer: archer._name,
    "First Name": archer["First Name"],
    "Last Name": archer["Last Name"],
    College: archer.College,
    "Bow Type": archer["Bow Type"],
    "Target Face": face,
    Category: archer.Category,
    Gender: archer.Gender,
    "Which Days": archer["Which Days"],
    "Membership Number": archer["Membership Number"],
    "Category Code": archer._code,
    "Session Preference": archer["Session Preference"],
    "Head-to-Head Eligible": hthEligible(archer),
  };
}

export const sortDraw = (draw) => draw.sort((left, right) =>
  left.Session - right.Session
  || left.Target - right.Target
  || String(left.Position).localeCompare(String(right.Position)));

// restore_imported_draw: rebuilds an existing scheduler or IANSEO draw.
// Never generates replacement allocations.
export function restoreImportedDraw(table, incoming) {
  if (!table.data.length) throw new Error("The imported file contains no data rows.");
  let columnNames = table.columns.map(clean);
  if (looksLikeIanseoHeaderless({ columns: columnNames, data: table.data })) columnNames = [...IANSEO_COLUMNS];

  const key = (value) => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const columns = new Map();
  columnNames.forEach((column, index) => {
    const normalized = key(column);
    if (normalized && !columns.has(normalized)) columns.set(normalized, index);
  });
  const findColumn = (...aliases) => {
    for (const alias of aliases) {
      const found = columns.get(key(alias));
      if (found !== undefined) return found;
    }
    return null;
  };
  const normalizeMember = (value) => {
    const text = clean(value);
    return /^\d+\.0$/.test(text) ? text.slice(0, -2) : text;
  };
  const cell = (row, column) => (column === null ? "" : normalizeMember(row[column]));

  const sessionColumn = findColumn("Session", "Session Number", "Shooting Session");
  const targetColumn = findColumn("Target", "Target Number", "Target No.", "Target Allocation", "Target/Position", "Target No. Position");
  const positionColumn = findColumn("Position", "Target Position Letter", "Lane", "Letter");
  const bibColumn = findColumn("Membership Number", "AI Number", "Bib", "Bib Number", "Archer Number", "ID");
  const givenColumn = findColumn("First Name", "Given Name", "Forename", "Name");
  const familyColumn = findColumn("Last Name", "Family Name", "Surname");
  const combinedColumn = findColumn("Archer", "Archer Name", "Full Name");
  const faceColumn = findColumn("Target Face", "Target Type", "Face Type");

  if (sessionColumn === null) {
    throw new Error("Cannot copy the existing schedule: no Session column found. "
      + `Available columns: [${columnNames.map(pyRepr).join(", ")}]`);
  }
  if (targetColumn === null) {
    throw new Error("Cannot copy the existing schedule: no Target column found. "
      + "Expected a target number, optionally with a position letter.");
  }
  if (bibColumn === null && combinedColumn === null && (givenColumn === null || familyColumn === null)) {
    throw new Error("Cannot match imported allocations to archers. "
      + "Provide Bib/Membership Number, an Archer column, or separate Name and Family Name columns.");
  }

  const roster = normalizeRoster(incoming.map(rosterRecord));
  if (!roster.length) throw new Error("Cannot restore a draw against an empty roster.");
  const normalizeName = (value) => collapse(casefold(value));
  const byBib = new Map();
  const byName = new Map();
  for (const archer of roster) {
    const bib = normalizeMember(archer["Membership Number"]);
    if (bib) {
      if (byBib.has(bib)) throw new Error(`The roster contains duplicate membership number ${pyRepr(bib)}.`);
      byBib.set(bib, archer);
    }
    const name = normalizeName(archer._name);
    if (name) byName.set(name, byName.has(name) ? null : archer);
  }

  const restored = [];
  const seenArchers = new Map();
  const seenPositions = new Set();
  const seenSessions = new Set();
  table.data.forEach((source, rowIndex) => {
    const sheetRow = rowIndex + 2;
    const sessionText = cell(source, sessionColumn);
    const targetText = cell(source, targetColumn);
    const positionText = cell(source, positionColumn).toUpperCase();

    if (!sessionText) throw new Error(`Session is blank on spreadsheet row ${sheetRow}. No schedule was copied.`);
    if (!/^\d+$/.test(sessionText)) throw new Error(`Invalid session ${pyRepr(sessionText)} on spreadsheet row ${sheetRow}.`);
    const session = Number(sessionText);
    if (session < 1) throw new Error(`Session must be at least 1 on spreadsheet row ${sheetRow}.`);
    if (!targetText) throw new Error(`Target is blank on spreadsheet row ${sheetRow}.`);

    const match = targetText.toUpperCase().match(/^(\d+)\s*([ABCD])$/);
    let target;
    let position;
    if (match) {
      target = Number(match[1]);
      if (positionText && positionText !== match[2]) {
        throw new Error(`Conflicting target positions on spreadsheet row ${sheetRow}: `
          + `${pyRepr(match[2])} in Target and ${pyRepr(positionText)} in Position.`);
      }
      position = match[2];
    } else {
      if (!/^\d+$/.test(targetText)) {
        throw new Error(`Cannot parse target ${pyRepr(targetText)} on spreadsheet row ${sheetRow}. `
          + "Expected a number or allocation such as '14A'.");
      }
      target = Number(targetText);
      position = positionText;
      if (!["A", "B", "C", "D"].includes(position)) {
        throw new Error(`Invalid or missing position ${pyRepr(position)} on spreadsheet row ${sheetRow}. `
          + "A numeric target requires a separate A/B/C/D Position.");
      }
    }
    if (target < 1) throw new Error(`Target must be at least 1 on spreadsheet row ${sheetRow}.`);

    const allocation = `${session}|${target}|${position}`;
    if (seenPositions.has(allocation)) {
      throw new Error(`Duplicate allocation ${session}/${target}${position} on spreadsheet row ${sheetRow}.`);
    }
    seenPositions.add(allocation);
    seenSessions.add(session);

    let member = cell(source, bibColumn);
    let archer;
    if (member) {
      archer = byBib.get(normalizeMember(member));
      if (!archer) {
        throw new Error(`Spreadsheet row ${sheetRow} references membership number ${pyRepr(member)}, `
          + "which is not in the roster. Check that the imported schedule and roster match.");
      }
    } else {
      const given = cell(source, givenColumn);
      const family = cell(source, familyColumn);
      const combined = cell(source, combinedColumn);
      let importedName;
      if (given || family) importedName = [given, family].filter(Boolean).join(" ");
      else if (combined) importedName = splitArcherName(combined).filter(Boolean).join(" ");
      else throw new Error(`No membership number or usable name on spreadsheet row ${sheetRow}.`);
      const nameKey = normalizeName(importedName);
      if (!byName.has(nameKey)) {
        throw new Error(`Could not match ${pyRepr(importedName)} on spreadsheet row ${sheetRow} to a roster member.`);
      }
      archer = byName.get(nameKey);
      if (archer === null) {
        throw new Error(`The name ${pyRepr(importedName)} on spreadsheet row ${sheetRow} matches multiple `
          + "roster members. Supply membership numbers to disambiguate.");
      }
      member = normalizeMember(archer["Membership Number"]);
    }

    if (seenArchers.has(member)) {
      throw new Error(`Archer ${pyRepr(archer._name)} has multiple imported allocations `
        + `(rows ${seenArchers.get(member)} and ${sheetRow}). Each archer must have exactly one `
        + "allocation in the imported draw.");
    }
    seenArchers.set(member, sheetRow);

    const importedFace = cell(source, faceColumn).toLowerCase();
    const face = ["3s", "40", "vegas"].includes(importedFace)
      ? importedFace === "vegas" ? "Vegas" : importedFace
      : archer._face;
    restored.push({ ...makeDrawRow(archer, session, target, position, face), "Membership Number": member });
  });

  if (!restored.length) throw new Error("No valid allocations were found. No schedule was copied.");
  const sessions = [...seenSessions].sort((left, right) => left - right);
  if (sessions.some((session, index) => session !== index + 1)) {
    throw new Error(`Imported sessions must be numbered consecutively from 1. Found sessions: [${sessions.join(", ")}].`);
  }
  return sortDraw(restored);
}

// The capacity recorded for later edits after copying a schedule, as the
// Streamlit import does: highest target used, Double if C/D is used.
export function importedCapacity(draw) {
  const sessions = [...new Set(draw.map((row) => row.Session))].sort((left, right) => left - right);
  return {
    targets: sessions.map((session) => Math.max(...draw.filter((row) => row.Session === session).map((row) => row.Target))),
    details: sessions.map((session) => (draw.some((row) => row.Session === session && ["C", "D"].includes(row.Position))
      ? "Double" : "Single")),
  };
}

// The roster merge used by "Import roster": incoming rows replace rows with
// the same membership number and are listed after the untouched rows.
export function mergeRoster(existing, incoming) {
  if (!existing.length) return incoming.map(rosterRecord);
  const incomingIds = new Set(incoming.map((archer) => archer["Membership Number"]));
  return [
    ...existing.filter((archer) => !incomingIds.has(archer["Membership Number"])).map(rosterRecord),
    ...incoming.map(rosterRecord),
  ];
}
