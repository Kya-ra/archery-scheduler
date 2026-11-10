// Compares the browser ports with app.py's outputs recorded by
// tests/python_parity.py. Regenerate the fixture after changing app.py.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  REQUIRED,
  classCodeToFields,
  normalizeRoster,
  prepareImportRoster,
  restoreImportedDraw,
  splitArcherName,
} from "../src/roster.js";
import { incompatibleFaces, refreshSummary, swapTargetBlockNumbers } from "../src/edits.js";
import { headToHeads, ianseoImportRows } from "../src/exports.js";

const read = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const cases = read("parity-cases.json");
const expected = read("python-parity.json");

const capture = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: error.message };
  }
};
const rosterOutput = (archers) => archers.map((archer) =>
  Object.fromEntries([...REQUIRED, "_name", "_face", "_code"].map((field) => [field, archer[field]])));
// Python's DataFrame records list keys present in any row; compare values only.
const pick = (rows, like) => rows.map((row, index) =>
  Object.fromEntries(Object.keys(like[index] ?? row).map((key) => [key, row[key] ?? null])));
const sameResult = (actual, wanted, message) => {
  if (wanted.error !== undefined) assert.equal(actual.error, wanted.error, message);
  else {
    assert.equal(actual.error, undefined, `${message}: ${actual.error}`);
    assert.deepEqual(pick(actual.value, wanted.value), wanted.value, message);
  }
};

test("split_archer_name", () => {
  cases.split.forEach((name, index) => assert.deepEqual(splitArcherName(name), expected.split[index], name));
});

test("prepare_import_roster", () => {
  cases.prepare.forEach((table, index) => sameResult(
    capture(() => rosterOutput(prepareImportRoster(table))), expected.prepare[index], `case ${index}`));
});

test("restore_imported_draw", () => {
  cases.restore.forEach(({ draw, roster }, index) => sameResult(
    capture(() => restoreImportedDraw(draw, prepareImportRoster(roster))), expected.restore[index], `case ${index}`));
});

test("head_to_heads", () => {
  cases.hth.forEach((roster, index) => assert.deepEqual(headToHeads(normalizeRoster(roster)), expected.hth[index]));
});

test("ianseo_import_dataframe", () => {
  cases.ianseo.forEach(({ roster, config, draw }, index) => sameResult(
    capture(() => ianseoImportRows(roster, config, draw)), expected.ianseo[index], `case ${index}`));
});

test("swap_target_block_numbers", () => {
  cases.swapBlocks.forEach(({ draw, spec }, index) => sameResult(
    capture(() => swapTargetBlockNumbers(draw, spec)), expected.swapBlocks[index], spec));
});

test("incompatible_faces", () => {
  cases.incompatible.forEach((draw, index) =>
    assert.deepEqual([...incompatibleFaces(draw)].sort(), expected.incompatible[index]));
});

test("class_code_to_fields", () => {
  cases.classFields.forEach(({ code, current }, index) => {
    const actual = capture(() => classCodeToFields(code, current));
    const wanted = expected.classFields[index];
    if (wanted.error !== undefined) assert.equal(actual.error, wanted.error, code);
    else assert.deepEqual(actual.value, wanted.value, code);
  });
});

test("refresh_summary", () => {
  cases.summary.forEach((draw, index) => assert.deepEqual(refreshSummary(draw), expected.summary[index]));
});
