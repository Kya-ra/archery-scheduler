import test from "node:test";
import assert from "node:assert/strict";
import loadHighs from "highs";
import { normalizeRoster, rosterRecord } from "../src/roster.js";
import { fullCapacityParityProblem } from "../src/scheduler.js";
import { solveSchedule, targetFaceSwaps } from "../src/solve.js";
import {
  batchSessionChanges,
  classSwaps,
  deleteAllocation,
  duplicateArcher,
  editArcher,
  swapDestinations,
  swapWithDestination,
} from "../src/edits.js";
import { classCountRows, ianseoText, shootingListCsv } from "../src/exports.js";

const config = { solver_time_limit_seconds: 20, default_session_by_college: {}, malleable_colleges: [], session_days: {} };
let highsPromise;
const highs = () => (highsPromise ??= loadHighs());

const record = (id, { bow = "recurve", category = "advanced", gender = "open", college = "QUB", preference = "" } = {}) => ({
  "First Name": id, "Last Name": "Archer", "Bow Type": bow, College: college, Gender: gender,
  Category: category, "Membership Number": id, "Which Days": "both days", "Session Preference": preference,
});

async function solve(roster, options = {}) {
  return solveSchedule(await highs(), {
    archers: normalizeRoster(roster),
    targets: options.targets ?? [1],
    details: options.details ?? ["Double"],
    config,
    mode: options.mode ?? "Standard",
    vegasMode: options.vegasMode ?? false,
    existingDraw: options.existingDraw ?? [],
    forcedSessions: options.forcedSessions ?? {},
    faceOverrides: options.faceOverrides ?? {},
  }).draw;
}

const slot = (row) => `${row.Session}.${row.Target}${row.Position}`;
const bySlot = (draw) => new Map(draw.map((row) => [slot(row), row]));

test("flags a full draw with an odd number of 3s archers", async () => {
  const roster = [
    record("A1", { college: "QUB" }), record("A2", { college: "UCC" }), record("A3", { college: "QUB" }),
    record("B1", { bow: "barebow", category: "intermediate", college: "UCC" }),
  ];
  const archers = normalizeRoster(roster);
  assert.match(fullCapacityParityProblem(archers, [1], ["Double"], false), /3 of them shoot 3s faces/);
  assert.equal(fullCapacityParityProblem(archers, [1], ["Double"], true), null);
  assert.equal(fullCapacityParityProblem(archers, [2], ["Double"], false), null);
  await assert.rejects(solve(roster), /no valid draw exists/);
});

test("forced sessions are hard constraints", async () => {
  const roster = ["A", "B", "C", "D", "E", "F", "G", "H"].map((id, index) =>
    record(id, { college: index % 2 ? "UCC" : "QUB" }));
  const draw = await solve(roster, { targets: [1, 1], details: ["Double", "Double"], forcedSessions: { 0: 2, 1: 2 } });
  assert.equal(draw.find((row) => row["Membership Number"] === "A").Session, 2);
  assert.equal(draw.find((row) => row["Membership Number"] === "B").Session, 2);
});

test("face overrides change the face rules and the recorded face", async () => {
  const roster = [
    record("R1", { college: "QUB" }), record("R2", { college: "UCC" }),
    record("B1", { bow: "barebow", category: "intermediate", college: "QUB" }),
    record("B2", { bow: "barebow", category: "intermediate", college: "UCC" }),
  ];
  const draw = await solve(roster, { faceOverrides: { 2: "3s" }, targets: [2] });
  assert.equal(draw.find((row) => row["Membership Number"] === "B1")["Target Face"], "3s");
});

test("target face swaps keep unaffected archers in place", async () => {
  const roster = [
    record("R1", { college: "QUB" }), record("R2", { college: "UCC" }),
    record("B1", { bow: "barebow", category: "intermediate", college: "QUB" }),
    record("B2", { bow: "barebow", category: "intermediate", college: "UCC" }),
  ];
  const draw = await solve(roster, { targets: [2] });
  const b1 = draw.find((row) => row["Membership Number"] === "B1");
  const result = targetFaceSwaps(await highs(), {
    draw, allocations: [slot(b1)], archers: normalizeRoster(roster), targets: [2], details: ["Double"],
    config, mode: "Standard", vegasMode: false,
  });
  assert.equal(result.draw.find((row) => row["Membership Number"] === "B1")["Target Face"], "3s");
  assert.deepEqual(result.failures, []);
});

test("batch session changes validate every line before solving", () => {
  const roster = [record("A"), record("B", { college: "UCC" })];
  const draw = [
    { Session: 1, Target: 1, Position: "A", "Membership Number": "A" },
    { Session: 1, Target: 1, Position: "B", "Membership Number": "B" },
  ];
  const result = batchSessionChanges("1.1A 2", draw, roster, [1, 1]);
  assert.deepEqual(result.forcedSessions, { 0: 2 });
  assert.equal(result.roster[0]["Session Preference"], "2");
  assert.throws(() => batchSessionChanges("1.1A 3\n1.1C 1\nnonsense", draw, roster, [1, 1]),
    /1.1A 3: destination session is out of range.; 1.1C: no uniquely allocated archer found.; nonsense: use '1.14A 2'./);
});

test("class swaps update the roster fields", () => {
  const roster = [record("A", { gender: "female" })];
  const draw = [{ Session: 1, Target: 1, Position: "A", "Membership Number": "A" }];
  const { roster: updated } = classSwaps("1.1A bbo", draw, roster);
  assert.deepEqual([updated[0]["Bow Type"], updated[0].Category, updated[0].Gender], ["barebow", "beginner", "open"]);
  assert.throws(() => classSwaps("1.1A ZZ", draw, roster), /1.1A: Unrecognised class code 'ZZ'./);
});

test("swapping with an empty position and with another archer", async () => {
  const roster = ["A", "B", "C", "D"].map((id, index) => record(id, { college: index % 2 ? "UCC" : "QUB" }));
  const draw = await solve(roster, { targets: [2] });
  const destinations = swapDestinations(draw, "A", [2], ["Double"]);
  assert.equal(destinations.length, 7);
  const empty = destinations.find((destination) => destination.label.startsWith("EMPTY"));
  const moved = swapWithDestination(draw, "A", empty);
  assert.equal(slot(moved.draw.find((row) => row["Membership Number"] === "A")), `${empty.session}.${empty.target}${empty.position}`);
  const other = destinations.find((destination) => !destination.label.startsWith("EMPTY"));
  const original = bySlot(draw);
  const exchanged = swapWithDestination(draw, "A", other);
  const otherMember = original.get(`${other.session}.${other.target}${other.position}`)["Membership Number"];
  const aBefore = draw.find((row) => row["Membership Number"] === "A");
  assert.equal(slot(exchanged.draw.find((row) => row["Membership Number"] === otherMember)), slot(aBefore));
});

test("an incompatible manual swap is rejected", () => {
  const draw = [
    { Session: 1, Target: 1, Position: "A", "Membership Number": "X", Archer: "X", "Target Face": "3s" },
    { Session: 1, Target: 2, Position: "C", "Membership Number": "Y", Archer: "Y", "Target Face": "40" },
  ];
  assert.throws(() => swapWithDestination(draw, "Y", { session: 1, target: 1, position: "C" }),
    /incompatible target-face combination/);
});

test("deleting an archer's last allocation removes them from the roster", () => {
  const roster = [record("A"), record("B")];
  const draw = [{ Session: 1, Target: 1, Position: "A", "Membership Number": "A" }];
  const result = deleteAllocation(draw, roster, { member: "A", session: 1, target: 1, position: "A" });
  assert.deepEqual(result.roster.map((archer) => archer["Membership Number"]), ["B"]);
  assert.match(result.notice, /removed from the roster/);
});

test("editing an archer rejects blank and duplicate membership numbers", () => {
  const roster = [record("A"), record("B")];
  assert.throws(() => editArcher(roster, "A", { ...roster[0], "Membership Number": " " }), /cannot be blank/);
  assert.throws(() => editArcher(roster, "A", { ...roster[0], "Membership Number": "B" }), /already belongs/);
  assert.equal(editArcher(roster, "A", { ...roster[0], College: " ucd " })[0].College, "ucd");
});

test("duplicates an archer as a guest in a compatible vacancy", async () => {
  const roster = [
    record("RB", { category: "beginner", college: "QUB" }), record("RA", { college: "UCC" }),
    record("BB", { bow: "barebow", category: "intermediate", college: "QUB" }),
    record("BC", { bow: "barebow", category: "intermediate", college: "UCC" }),
    record("S2A", { college: "QUB", preference: "2" }), record("S2B", { college: "UCC", preference: "2" }),
    record("S2C", { college: "UCD", preference: "2" }), record("S2D", { college: "UL", preference: "2" }),
  ];
  const draw = await solve(roster, { targets: [2, 2], details: ["Double", "Double"] });
  const sourceIndex = draw.findIndex((row) => row["Membership Number"] === "RB");
  const result = duplicateArcher({
    draw, roster, sourceIndex, destination: 3 - draw[sourceIndex].Session, lastTargets: [2, 2], lastDetails: ["Double", "Double"], vegasMode: false,
  });
  const copy = result.draw.find((row) => row["Membership Number"] === "RB-DUP1");
  // The copy keeps the recurve beginner's 40 face and shares a 40 pair.
  assert.equal(copy["Target Face"], "40");
  assert.equal(copy.Category, "guest");
  assert.equal(copy["Category Code"], "RG");
  const partner = result.draw.find((row) => row.Session === copy.Session && row !== copy && row.Target === copy.Target
    && row.Position === { A: "C", C: "A", B: "D", D: "B" }[copy.Position]);
  if (partner) assert.equal(partner["Target Face"], "40");
  assert.equal(result.roster.at(-1).Category, "guest");
  assert.equal(normalizeRoster(result.roster).length, 9);
});

test("exports use pandas-style booleans and minimal quoting", () => {
  const roster = normalizeRoster([record("A", { college: "QUB" })]);
  const csv = shootingListCsv([{ Session: 1, Target: 1, Position: "A", Archer: "A, Jr", "Head-to-Head Eligible": true }]);
  assert.ok(csv.startsWith("﻿Session,Target,Position,Archer,"));
  assert.match(csv, /1,1,A,"A, Jr",/);
  assert.match(csv, /,True\n$/);
  assert.equal(ianseoText([{ Bib: "1", Name: "x\ty" }]).split("\t")[0], "1");
  assert.deepEqual(classCountRows(roster.map(rosterRecord)), [[["RAO", 1]]]);
});

test("exported CSV and Excel schedules copy back in unchanged", async () => {
  const { prepareImportRoster, readEntryFile, restoreImportedDraw } = await import("../src/roster.js");
  const { headToHeads, workbookBytes } = await import("../src/exports.js");
  const { refreshSummary } = await import("../src/edits.js");
  const roster = ["A", "B", "C", "D", "E", "F"].map((id, index) => record(`${id}0${index}`, {
    college: index % 2 ? "UCC" : "QUB", preference: index === 0 ? "1" : "",
  }));
  roster[1]["First Name"] = "Pádraig";
  roster[1]["Last Name"] = "MAC LOCHLAINN";
  const draw = await solve(roster, { targets: [1, 1], details: ["Double", "Double"] });
  const slots = (rows) => rows.map((row) => `${row["Membership Number"]}@${slot(row)}`).sort();
  const files = [
    new File([shootingListCsv(draw)], "shooting_list.csv"),
    new File([await workbookBytes(draw, headToHeads(normalizeRoster(roster)), refreshSummary(draw))], "archery_schedule.xlsx"),
  ];
  for (const file of files) {
    const table = await readEntryFile(file);
    const restored = restoreImportedDraw(table, prepareImportRoster(table));
    assert.deepEqual(slots(restored), slots(draw), file.name);
    assert.equal(restored.find((row) => row["Membership Number"] === "B01")["Last Name"], "MAC LOCHLAINN", file.name);
    assert.equal(restored.find((row) => row["Membership Number"] === "A00")["Session Preference"], "1", file.name);
  }
});

test("face overrides persist only while bow, category and gender are unchanged", async () => {
  const { setOverride, reconcileOverrides, overridesFromDraw, indexedOverrides } = await import("../src/overrides.js");
  const roster = [record("B1", { bow: "barebow", category: "intermediate" }), record("R1", { college: "UCC" })];
  let overrides = setOverride({}, roster, "B1", "3s");
  assert.deepEqual(overrides, { B1: "3s" });
  assert.deepEqual(setOverride(overrides, roster, "B1", "40"), {}, "returning to the derived face clears it");
  assert.deepEqual(setOverride({}, roster, "R1", "Vegas"), {}, "Vegas is the 3s face");
  assert.deepEqual(indexedOverrides(normalizeRoster(roster), overrides), { 0: "3s" });
  const renamedCollege = roster.map((archer) => ({ ...archer, College: "UL" }));
  assert.deepEqual(reconcileOverrides(roster, renamedCollege, overrides), overrides);
  const reclassed = roster.map((archer) => ({ ...archer, Category: "beginner" }));
  assert.deepEqual(reconcileOverrides(roster, reclassed, overrides), {});
  assert.deepEqual(reconcileOverrides(roster, roster.slice(1), overrides), {});
  overrides = overridesFromDraw([{ "Membership Number": "B1", "Target Face": "3s" }, { "Membership Number": "R1", "Target Face": "3s" }], roster);
  assert.deepEqual(overrides, { B1: "3s" });
});

test("a face swap survives regeneration until the class changes", async () => {
  const { setOverride, indexedOverrides, reconcileOverrides } = await import("../src/overrides.js");
  const roster = [
    record("R1", { college: "QUB" }), record("R2", { college: "UCC" }),
    record("B1", { bow: "barebow", category: "intermediate", college: "QUB" }),
    record("B2", { bow: "barebow", category: "intermediate", college: "UCC" }),
  ];
  const archers = normalizeRoster(roster);
  const draw = await solve(roster, { targets: [2] });
  const b1 = draw.find((row) => row["Membership Number"] === "B1");
  const swapped = targetFaceSwaps(await highs(), {
    draw, allocations: [slot(b1)], archers, targets: [2], details: ["Double"],
    config, mode: "Standard", vegasMode: false, faceOverrides: {},
  });
  assert.deepEqual(swapped.applied, { B1: "3s" });
  const overrides = setOverride({}, roster, "B1", "3s");
  // Regenerating (e.g. after another edit) keeps the swapped face.
  const regenerated = await solve(roster, {
    targets: [2], existingDraw: swapped.draw, faceOverrides: indexedOverrides(archers, overrides),
  });
  assert.equal(regenerated.find((row) => row["Membership Number"] === "B1")["Target Face"], "3s");
  // A class swap recalculates the face.
  const reclassed = roster.map((archer) => (archer["Membership Number"] === "B1" ? { ...archer, Category: "advanced" } : archer));
  assert.deepEqual(reconcileOverrides(roster, reclassed, overrides), {});
});

test("a duplicate copies a face-swapped source's face", async () => {
  const roster = [
    record("RB", { category: "beginner", college: "QUB" }), record("RA", { college: "UCC" }),
    record("BB", { bow: "barebow", category: "intermediate", college: "QUB" }),
    record("BC", { bow: "barebow", category: "intermediate", college: "UCC" }),
  ];
  const draw = [
    { ...normalizeRoster([roster[0]])[0], Session: 1, Target: 1, Position: "A", Archer: "RB Archer", "Membership Number": "RB", "Target Face": "3s" },
    { Session: 2, Target: 1, Position: "A", Archer: "RA Archer", "Membership Number": "RA", "Target Face": "3s" },
    { Session: 2, Target: 1, Position: "B", Archer: "BB Archer", "Membership Number": "BB", "Target Face": "40" },
  ];
  const result = duplicateArcher({
    draw, roster, sourceIndex: 0, destination: 2, lastTargets: [1, 1], lastDetails: ["Double", "Double"], vegasMode: false,
  });
  assert.deepEqual(result.duplicate, { member: "RB-DUP1", face: "3s" });
  assert.equal(result.draw.find((row) => row["Membership Number"] === "RB-DUP1").Position, "C");
});
