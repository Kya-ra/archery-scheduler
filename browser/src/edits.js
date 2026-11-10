// "Modify the draw" operations from app.py, as pure functions over the
// draw (allocation rows) and roster (REQUIRED records). Operations that need
// the solver return what to solve; main.js runs it in the worker.
import {
  REQUIRED,
  classCodeToFields,
  clean,
  normalizeRoster,
  parseSessionPreferences,
  pyRepr,
  rosterRecord,
  sortDraw,
  targetFace,
} from "./roster.js";

const positionsFor = (detail) => (detail === "Single" ? ["A", "B"] : ["A", "B", "C", "D"]);

// parse_allocation
export function parseAllocation(value) {
  const match = String(value).toUpperCase().match(/^\s*(\d+)\.(\d+)([ABCD])\s*$/);
  if (!match) throw new Error(`Invalid allocation ${pyRepr(value)}; use a format such as 1.14A.`);
  return { session: Number(match[1]), target: Number(match[2]), position: match[3] };
}

export const allocationLabel = (row) => `${Number(row.Session)}.${Number(row.Target)}${row.Position}`;
export const archerAllocationLabel = (row) =>
  `${row.Archer ?? "Unknown"} (${row["Membership Number"]}) — ${allocationLabel(row)}`;

const at = (draw, session, target, position) =>
  draw.filter((row) => row.Session === session && row.Target === target && row.Position === position);

// refresh_summary
export function refreshSummary(draw) {
  const sessions = [...new Set(draw.map((row) => row.Session))].sort((left, right) => left - right);
  return sessions.map((session) => {
    const rows = draw.filter((row) => row.Session === session);
    return { Session: session, Archers: rows.length, Targets_Used: new Set(rows.map((row) => row.Target)).size };
  });
}

// incompatible_faces: "session|target" keys whose A/C or B/D faces differ.
export function incompatibleFaces(draw) {
  const conflicts = new Set();
  const groups = new Map();
  for (const row of draw) {
    const key = `${row.Session}|${row.Target}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [key, rows] of groups) {
    for (const pair of [["A", "C"], ["B", "D"]]) {
      const faces = new Set(rows
        .filter((row) => pair.includes(row.Position))
        .map((row) => (String(row["Target Face"]).toLowerCase() === "vegas" ? "40" : row["Target Face"])));
      if (faces.size > 1) conflicts.add(key);
    }
  }
  return conflicts;
}

// swap_target_block_numbers: '8-9' in every session, or '1.8-9' in one.
export function swapTargetBlockNumbers(draw, spec) {
  const match = String(spec).match(/^\s*(?:(\d+)\s*\.\s*)?(\d+)\s*-\s*(\d+)\s*$/);
  if (!match) throw new Error("Enter targets as 8-9, or specify a session as 1.8-9.");
  const session = match[1] ? Number(match[1]) : null;
  const first = Number(match[2]);
  const second = Number(match[3]);
  if (session !== null && session < 1) throw new Error("Session numbers must be positive integers.");
  if (first < 1 || second < 1) throw new Error("Target numbers must be positive integers.");
  if (first === second) throw new Error("Choose two different target numbers.");
  if (session !== null && !draw.some((row) => row.Session === session)) {
    throw new Error(`Session ${session} does not exist in the current draw.`);
  }
  const inScope = (row) => session === null || row.Session === session;
  if (!draw.some((row) => inScope(row) && [first, second].includes(row.Target))) {
    throw new Error(`Neither target ${first} nor target ${second} exists${session !== null ? ` in session ${session}` : ""}.`);
  }
  return sortDraw(draw.map((row) => {
    if (!inScope(row)) return { ...row };
    if (row.Target === first) return { ...row, Target: second };
    if (row.Target === second) return { ...row, Target: first };
    return { ...row };
  }));
}

// Every position a "Swap with specific archer" move can target.
export function swapDestinations(draw, member, lastTargets, lastDetails) {
  const destinations = [];
  lastTargets.forEach((count, sessionIndex) => {
    const session = sessionIndex + 1;
    for (let target = 1; target <= Number(count); target += 1) {
      for (const position of positionsFor(lastDetails[sessionIndex])) {
        const [row] = at(draw, session, target, position);
        if (row && String(row["Membership Number"]) === member) continue;
        destinations.push({
          session, target, position,
          label: row ? `${row.Archer} (${row["Membership Number"]}) — ${session}.${target}${position}`
            : `EMPTY — ${session}.${target}${position}`,
        });
      }
    }
  });
  return destinations;
}

// "Swap with specific archer": exchange with an archer, or move into an
// empty position. Does not call the solver.
export function swapWithDestination(draw, member, destination) {
  const sources = draw.filter((row) => String(row["Membership Number"]) === member);
  if (sources.length !== 1) {
    throw new Error("The selected membership number is duplicated. Allocation-specific identity is required.");
  }
  const source = sources[0];
  const updated = draw.map((row) => ({ ...row }));
  const sourceIndex = draw.indexOf(source);
  const destinationIndex = draw.findIndex((row) => row.Session === destination.session
    && row.Target === destination.target && row.Position === destination.position);
  const place = (row, location) => Object.assign(row, {
    Session: location.session, Target: location.target, Position: location.position,
  });
  if (destinationIndex >= 0) {
    place(updated[destinationIndex], {
      session: Number(source.Session), target: Number(source.Target), position: String(source.Position).toUpperCase(),
    });
  }
  place(updated[sourceIndex], destination);
  if (incompatibleFaces(updated).has(`${destination.session}|${destination.target}`)) {
    throw new Error("This move creates an incompatible target-face combination.");
  }
  return {
    draw: sortDraw(updated),
    notice: `Moved ${source.Archer} to ${destination.session}.${destination.target}${destination.position}.`,
  };
}

// "Delete an archer or allocation": one allocation; the roster entry goes
// too once the archer has no allocations left.
export function deleteAllocation(draw, roster, { member, session, target, position }) {
  const matches = draw.filter((row) => String(row["Membership Number"]) === member
    && row.Session === session && row.Target === target && String(row.Position) === position);
  if (matches.length !== 1) throw new Error("The allocation could not be uniquely identified. Nothing was deleted.");
  const updatedDraw = draw.filter((row) => row !== matches[0]);
  const archerRemoved = !updatedDraw.some((row) => String(row["Membership Number"]) === member);
  return {
    draw: updatedDraw,
    roster: archerRemoved ? roster.filter((archer) => String(archer["Membership Number"]) !== member) : roster,
    notice: archerRemoved
      ? `Deleted allocation ${session}.${target}${position} for membership number ${member}. `
        + "The archer had no remaining allocations and was removed from the roster."
      : `Deleted allocation ${session}.${target}${position} for membership number ${member}. `
        + "Other allocations and the roster entry were retained.",
  };
}

export function deleteArcher(draw, roster, member) {
  return {
    draw: draw.filter((row) => String(row["Membership Number"]) !== member),
    roster: roster.filter((archer) => String(archer["Membership Number"]) !== member),
    notice: `Removed membership number ${member} from the roster and all session allocations.`,
  };
}

// "Edit archer": validates and applies the edited REQUIRED fields.
export function editArcher(roster, member, edited) {
  const index = roster.findIndex((archer) => String(archer["Membership Number"]) === member);
  if (index < 0) throw new Error(`Membership number ${member} is not in the roster.`);
  const newMember = clean(edited["Membership Number"]);
  if (!newMember) throw new Error("Membership Number cannot be blank.");
  if (roster.some((archer, other) => other !== index && String(archer["Membership Number"]) === newMember)) {
    throw new Error("That membership number already belongs to another archer.");
  }
  const updated = roster.map(rosterRecord);
  for (const field of REQUIRED) updated[index][field] = clean(edited[field]);
  return updated;
}

// "Generic session preference"
export function applySessionPreference(roster, member, text, sessionCount) {
  const preferences = parseSessionPreferences(text);
  if (!preferences.length || preferences.some((session) => session < 1 || session > sessionCount)) {
    throw new Error(`Enter session numbers from 1 to ${sessionCount}.`);
  }
  return roster.map((archer) => (String(archer["Membership Number"]) === member
    ? { ...rosterRecord(archer), "Session Preference": preferences.join(", ") }
    : rosterRecord(archer)));
}

// "Batch session changes": lines such as '1.14A 2'. Returns the roster with
// updated preferences and the forced sessions keyed by roster index.
export function batchSessionChanges(text, draw, roster, lastTargets) {
  const instructions = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!instructions.length) throw new Error("Enter at least one allocation and destination session.");
  const changes = new Map();
  const errors = [];
  for (const instruction of instructions) {
    const parts = instruction.split(/\s+/);
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
      errors.push(`${instruction}: use '1.14A 2'.`);
      continue;
    }
    const [allocation, destinationText] = parts;
    const destination = Number(destinationText);
    if (destination < 1 || destination > lastTargets.length) {
      errors.push(`${instruction}: destination session is out of range.`);
      continue;
    }
    let location;
    try {
      location = parseAllocation(allocation);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const found = at(draw, location.session, location.target, location.position);
    if (found.length !== 1) {
      errors.push(`${allocation}: no uniquely allocated archer found.`);
      continue;
    }
    const member = clean(found[0]["Membership Number"]);
    const rosterMatches = roster
      .map((archer, index) => ({ archer, index }))
      .filter(({ archer }) => clean(archer["Membership Number"]) === member);
    if (!rosterMatches.length) {
      errors.push(`${allocation}: could not find the archer in the roster.`);
      continue;
    }
    if (rosterMatches.length > 1) {
      errors.push(`${allocation}: membership number ${pyRepr(member)} belongs to multiple roster rows. `
        + "A unique archer ID is needed to distinguish the original from its duplicate.");
      continue;
    }
    const { index } = rosterMatches[0];
    if (changes.has(index)) {
      errors.push(`${allocation}: this archer is listed more than once.`);
      continue;
    }
    changes.set(index, destination);
  }
  if (errors.length) throw new Error(errors.join("; "));
  const updated = roster.map(rosterRecord);
  for (const [index, destination] of changes) updated[index]["Session Preference"] = String(destination);
  return { roster: updated, forcedSessions: Object.fromEntries(changes), count: changes.size };
}

// "Swap archer class": lines such as '1.14A RBF'.
export function classSwaps(text, draw, roster) {
  const instructions = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!instructions.length) throw new Error("Enter at least one allocation and destination class.");
  const changes = new Map();
  const errors = [];
  for (const instruction of instructions) {
    const parts = instruction.split(/\s+/);
    if (parts.length !== 2) {
      errors.push(`${instruction}: use '1.14A RBF'.`);
      continue;
    }
    const [allocation, newClass] = [parts[0], parts[1].toUpperCase()];
    let location;
    try {
      location = parseAllocation(allocation);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const matches = at(draw, location.session, location.target, location.position);
    if (matches.length !== 1) {
      errors.push(`${allocation}: no uniquely allocated archer found.`);
      continue;
    }
    const member = String(matches[0]["Membership Number"]);
    if (changes.has(member)) {
      errors.push(`${allocation}: this archer is listed more than once.`);
      continue;
    }
    const rows = roster.filter((archer) => String(archer["Membership Number"]) === member);
    if (rows.length !== 1) {
      errors.push(`${allocation}: could not uniquely find the archer in the roster.`);
      continue;
    }
    try {
      changes.set(member, classCodeToFields(newClass, rows[0]));
    } catch (error) {
      errors.push(`${allocation}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  const updated = roster.map((archer) => {
    const fields = changes.get(String(archer["Membership Number"]));
    return fields ? { ...rosterRecord(archer), ...fields } : rosterRecord(archer);
  });
  return { roster: updated, count: changes.size };
}

// Face rules for duplicate placement: paired positions share a face, and a
// target holding both face types uses 3s on A/C and 40 on B/D.
function validTargetFaces(rows) {
  const faces = {};
  for (const row of rows) faces[clean(row.Position).toUpperCase()] = clean(row["Target Face"]).toLowerCase();
  for (const [left, right] of [["A", "C"], ["B", "D"]]) {
    if (left in faces && right in faces && faces[left] !== faces[right]) return false;
  }
  const types = new Set(Object.values(faces));
  if (types.has("3s") && types.has("40")) {
    if (["A", "C"].some((position) => position in faces && faces[position] !== "3s")) return false;
    if (["B", "D"].some((position) => position in faces && faces[position] !== "40")) return false;
  }
  return true;
}

const PAIRED = { A: "C", C: "A", B: "D", D: "B" };

// "Duplicate archer into another session": the copy becomes a Guest with a
// new membership ID, placed in a vacancy compatible with its face. If none
// exists, one archer may move to free a compatible pair.
export function duplicateArcher({ draw, roster, sourceIndex, destination, lastTargets, lastDetails, vegasMode }) {
  const current = draw.map((row) => ({ ...row }));
  const sourceRow = draw[sourceIndex];
  const sourceMatches = current.filter((row) => row.Session === sourceRow.Session
    && row.Target === sourceRow.Target
    && String(row.Position).toUpperCase() === String(sourceRow.Position).toUpperCase()
    && String(row["Membership Number"]) === String(sourceRow["Membership Number"]));
  if (sourceMatches.length !== 1) {
    throw new Error("The source allocation is no longer unique. Refresh the page and try again.");
  }
  const source = { ...sourceMatches[0] };
  const member = clean(source["Membership Number"]);
  if (current.some((row) => row.Session === destination && String(row["Membership Number"]) === member)) {
    throw new Error(`This archer already has an allocation in session ${destination}.`);
  }

  let targetLimit;
  let positions;
  if (destination <= lastTargets.length) {
    targetLimit = Number(lastTargets[destination - 1]);
    positions = positionsFor(lastDetails[destination - 1]);
  } else {
    targetLimit = Math.max(1, ...current.map((row) => Number(row.Target)));
    positions = ["A", "B", "C", "D"];
  }

  // Rows in the destination session, with their index into `current`.
  let destinationRows = () => current.map((row, index) => ({ row, index })).filter(({ row }) => row.Session === destination);
  const rowsAt = (rows, target) => rows.filter(({ row }) => Number(row.Target) === target).map(({ row }) => row);
  const occupied = (rows, target, position) => rows.some(({ row }) =>
    Number(row.Target) === target && clean(row.Position).toUpperCase() === position);
  const compatibleVacancy = (rows, target, position, face) => {
    if (occupied(rows, target, position)) return false;
    const partners = rowsAt(rows, target).filter((row) => clean(row.Position).toUpperCase() === PAIRED[position]);
    if (partners.length && !partners.every((row) => clean(row["Target Face"]).toLowerCase() === face)) return false;
    return validTargetFaces(rowsAt(rows, target));
  };

  // The copy keeps the source archer's face (as app.py does for faces
  // derived from the roster), including a face set by an override, and is
  // placed by that face so its pair stays consistent. A recurve beginner's
  // copy therefore stays on 40 although Guests normally shoot 3s.
  let requiredFace = clean(source["Target Face"]).toLowerCase();
  if (!["3s", "40", "vegas"].includes(requiredFace)) requiredFace = targetFace({ ...source, _name: source.Archer });
  if (!vegasMode && requiredFace === "vegas") requiredFace = "3s";
  if (vegasMode && requiredFace === "3s") requiredFace = "vegas";

  let chosen = null;
  const rows = destinationRows();
  for (let target = 1; target <= targetLimit && !chosen; target += 1) {
    for (const position of positions) {
      if (vegasMode ? !occupied(rows, target, position) : compatibleVacancy(rows, target, position, requiredFace)) {
        chosen = { target, position };
        break;
      }
    }
  }

  if (!chosen && !vegasMode) {
    search: for (let target = 1; target <= targetLimit; target += 1) {
      for (const position of positions) {
        const sessionRows = destinationRows();
        if (occupied(sessionRows, target, position)) continue;
        const partners = sessionRows.filter(({ row }) => Number(row.Target) === target
          && clean(row.Position).toUpperCase() === PAIRED[position]);
        if (!partners.length) continue;
        if (partners.every(({ row }) => clean(row["Target Face"]).toLowerCase() === requiredFace)) continue;
        for (const partner of partners) {
          for (let newTarget = 1; newTarget <= targetLimit; newTarget += 1) {
            if (newTarget === target) continue;
            for (const newPosition of positions) {
              if (occupied(sessionRows, newTarget, newPosition)) continue;
              const trial = sessionRows.map(({ row, index }) => ({
                index,
                row: index === partner.index ? { ...row, Target: newTarget, Position: newPosition } : row,
              }));
              if (!validTargetFaces(rowsAt(trial, target))) continue;
              if (!validTargetFaces(rowsAt(trial, newTarget))) continue;
              if (!compatibleVacancy(trial, target, position, requiredFace)) continue;
              Object.assign(current[partner.index], { Target: newTarget, Position: newPosition });
              chosen = { target, position };
              break search;
            }
          }
        }
      }
    }
  }

  if (!chosen) {
    throw new Error(`Session ${destination} has no vacant position compatible with face type ${pyRepr(requiredFace)}. `
      + "No valid single-archer rearrangement was found. Increase capacity or adjust the draw.");
  }

  const existingIds = new Set([...roster, ...current].map((row) => clean(row["Membership Number"])));
  let suffix = 1;
  let duplicateMember = `${member}-DUP${suffix}`;
  while (existingIds.has(duplicateMember)) {
    suffix += 1;
    duplicateMember = `${member}-DUP${suffix}`;
  }

  const rosterMatches = roster.filter((archer) => clean(archer["Membership Number"]) === member);
  if (rosterMatches.length !== 1) {
    throw new Error(`Expected exactly one roster record for membership ${pyRepr(member)}; found ${rosterMatches.length}.`);
  }
  const updatedRoster = [
    ...roster.map(rosterRecord),
    { ...rosterRecord(rosterMatches[0]), "Membership Number": duplicateMember, Category: "guest" },
  ];

  const bow = clean(source["Bow Type"]);
  const duplicate = {
    ...source,
    Session: destination,
    "Session Preference": destination,
    Target: chosen.target,
    Position: chosen.position,
    "Membership Number": duplicateMember,
    "Target Face": requiredFace === "vegas" ? "Vegas" : requiredFace,
    Category: "guest",
    "Category Code": bow ? `${bow[0].toUpperCase()}G` : "G",
    "Head-to-Head Eligible": false,
  };
  // As in app.py, record the source's session on its own draw rows.
  for (const row of current) {
    if (String(row["Membership Number"]) === String(source["Membership Number"])) {
      row["Session Preference"] = String(Number(source.Session));
    }
  }
  const updatedDraw = [...current, duplicate];
  const slots = new Set();
  for (const row of updatedDraw) {
    const slot = `${row.Session}|${row.Target}|${row.Position}`;
    if (slots.has(slot)) throw new Error("The new allocation conflicts with an existing archer.");
    slots.add(slot);
  }
  normalizeRoster(updatedRoster);
  return {
    draw: sortDraw(updatedDraw),
    roster: updatedRoster,
    duplicate: { member: duplicateMember, face: duplicate["Target Face"] },
    notice: `Duplicated ${source.Archer ?? member} into session ${destination}, target ${chosen.target}${chosen.position}. `
      + `The new copy is a Guest with membership ID ${duplicateMember} and is excluded from head-to-head `
      + "eligibility. The original remains unchanged.",
  };
}
