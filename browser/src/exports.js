// Reports and downloads from app.py: head-to-heads, class counts, the
// shooting list CSV, the Excel workbook and the IANSEO List Load rows.
import {
  DRAW_COLUMNS,
  IANSEO_COLUMNS,
  VALID_HTH,
  categoryCode,
  clean,
  hthEligible,
  normalizeRoster,
  pyRepr,
} from "./roster.js";

export const HTH_COLUMNS = [
  "Category", "Entrants", "Elimination Rounds", "Bracket Matches",
  "Bronze Match", "Total Matches Including Bronze", "Matches By Round",
];
export const SUMMARY_COLUMNS = ["Session", "Archers", "Targets_Used"];

const CLASS_COUNT_ORDER = [
  "BBO", "BBF", "BIO", "BIF", "BAO", "BAF", "BS", "BG",
  "RBO", "RBF", "RIO", "RIF", "RAO", "RAF", "RS", "RG",
  "CO", "CF", "CS", "CG",
];

// head_to_heads: knockout structure for every eligible class.
export function headToHeads(archers) {
  const counts = new Map();
  for (const archer of archers.filter(hthEligible)) counts.set(archer._code, (counts.get(archer._code) ?? 0) + 1);
  const report = [];
  for (const code of [...VALID_HTH].sort()) {
    const entrants = counts.get(code) ?? 0;
    if (!entrants) continue;
    const rounds = entrants > 1 ? Math.ceil(Math.log2(entrants)) : 0;
    const bracketMatches = Math.max(0, entrants - 1);
    const bronze = entrants >= 3 ? 1 : 0;
    const stages = [];
    if (entrants > 1) {
      const bracketSize = 2 ** Math.ceil(Math.log2(entrants));
      const byes = bracketSize - entrants;
      const firstRound = Math.floor((entrants - byes) / 2);
      if (firstRound) stages.push(String(firstRound));
      let remaining = entrants - firstRound;
      while (remaining > 2) {
        const matches = Math.floor(remaining / 2);
        stages.push(String(matches));
        remaining -= matches;
      }
      stages.push(entrants < 4 ? "G" : "GB");
    }
    report.push({
      Category: code,
      Entrants: entrants,
      "Elimination Rounds": rounds,
      "Bracket Matches": bracketMatches,
      "Bronze Match": bronze ? "Yes" : "No",
      "Total Matches Including Bronze": bracketMatches + bronze,
      "Matches By Round": stages.join(" → "),
    });
  }
  return report;
}

// render_archer_class_counts: populated classes, four per row.
export function classCountRows(roster) {
  const counts = new Map();
  for (const archer of roster) {
    const code = categoryCode(archer).toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const populated = CLASS_COUNT_ORDER.filter((code) => counts.get(code)).map((code) => [code, counts.get(code)]);
  const rows = [];
  for (let offset = 0; offset < populated.length; offset += 4) rows.push(populated.slice(offset, offset + 4));
  return rows;
}

// pandas-style cell text: booleans as True/False.
const cellText = (value) => (typeof value === "boolean" ? (value ? "True" : "False") : String(value ?? ""));

// Minimal quoting, as pandas.DataFrame.to_csv writes it.
function delimited(rows, separator) {
  const quote = (value) => {
    const text = cellText(value);
    return /["\r\n]/.test(text) || text.includes(separator) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(quote).join(separator)).join("\n") + (rows.length ? "\n" : "");
}

const tableRows = (records, columns) => records.map((record) => columns.map((column) => record[column]));

export function shootingListCsv(draw) {
  return `﻿${delimited([DRAW_COLUMNS, ...tableRows(draw, DRAW_COLUMNS)], ",")}`;
}

// workbook_bytes: Shooting List, Head to Heads and Session Summary sheets.
// SheetJS is loaded on first use to keep it out of the initial page load.
export async function workbookBytes(draw, hth, summary) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = (records, columns) => XLSX.utils.aoa_to_sheet([columns, ...tableRows(records, columns)]);
  XLSX.utils.book_append_sheet(workbook, sheet(draw, DRAW_COLUMNS), "Shooting List");
  XLSX.utils.book_append_sheet(workbook, hth.length ? sheet(hth, HTH_COLUMNS) : XLSX.utils.aoa_to_sheet([]), "Head to Heads");
  XLSX.utils.book_append_sheet(workbook, sheet(summary, SUMMARY_COLUMNS), "Session Summary");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

// ianseo_import_dataframe: the 21 ordered, headerless List Load columns.
export function ianseoImportRows(roster, config, draw) {
  const archers = normalizeRoster(roster);
  const shortNames = Object.fromEntries(Object.entries(config.college_short_names ?? {})
    .map(([college, name]) => [clean(college).toUpperCase(), clean(name)]));

  const allocations = new Map();
  for (const row of draw) {
    const member = clean(row["Membership Number"]);
    if (!member) continue;
    const name = clean(row.Archer).split(/\s+/).filter(Boolean).join(" ").toLowerCase();
    const existing = allocations.get(member);
    if (existing) {
      if (existing.Archer !== name) {
        throw new Error(`Multiple shooting allocations found for membership number ${pyRepr(member)}, `
          + `but the archer names do not match: ${pyRepr(existing.Archer)} and ${pyRepr(name)}.`);
      }
      continue;
    }
    allocations.set(member, {
      Session: Number(row.Session),
      Target: Number(row.Target),
      Position: clean(row.Position).toUpperCase(),
      Archer: name,
    });
  }

  return archers.map((archer) => {
    const code = clean(archer._code).toUpperCase();
    if (!code || !["B", "C", "R"].includes(code[0])) {
      throw new Error(`Cannot export ${archer._name}: invalid category code ${pyRepr(code)}.`);
    }
    const bib = clean(archer["Membership Number"]);
    if (!bib) throw new Error(`Cannot export ${archer._name}: membership number is blank.`);
    const allocation = allocations.get(bib);
    if (!allocation) throw new Error(`Cannot export ${archer._name}: no shooting allocation was found.`);
    const college = clean(archer.College).toUpperCase();
    if (!shortNames[college]) {
      throw new Error(`No IANSEO short name configured for college ${pyRepr(college)}. `
        + "Add it to college_short_names in config.json.");
    }
    const entry = archer["Which Days"] === "both days" ? "1" : "";
    return {
      Bib: bib,
      Session: String(allocation.Session),
      Division: code[0],
      Class: code.slice(1),
      Target: `${allocation.Target}${allocation.Position}`,
      "Individual - Division/Class": "1",
      "Team - Division/Class": "1",
      "Ind. Events": entry,
      "Team Events": entry,
      "Mixed Team Events": entry,
      "Family Name": archer["Last Name"],
      Name: archer["First Name"],
      Gender: "U",
      Country: college,
      "Country Name": shortNames[college],
      "Date of Birth": "",
      Subclass: "",
      "Country 2": "",
      "Country Name 2": "",
      "Country 3": "",
      "Country Name 3": "",
    };
  });
}

export const ianseoText = (rows) => delimited(tableRows(rows, IANSEO_COLUMNS), "\t");
