import test from "node:test";
import assert from "node:assert/strict";
import loadHighs from "highs";
import { fitTargetCapacity } from "../src/scheduler.js";
import {
  DRAW_COLUMNS,
  normalizeRoster,
  prepareImportRoster,
  restoreImportedDraw,
} from "../src/roster.js";
import { solveSchedule } from "../src/solve.js";

const baseConfig = {
  solver_time_limit_seconds: 20,
  default_session_by_college: {},
  malleable_colleges: [],
  session_days: {},
};
let highsPromise;

function archer(id, {
  bow = "recurve",
  category = "advanced",
  gender = "open",
  college = "QUB",
  preference = "",
} = {}) {
  return normalizeRoster([{
    "First Name": id,
    "Last Name": "Archer",
    "Bow Type": bow,
    College: college,
    Gender: gender,
    Category: category,
    "Membership Number": id,
    "Which Days": "both days",
    "Session Preference": preference,
  }])[0];
}

async function solve(archers, options = {}) {
  highsPromise ??= loadHighs();
  const highs = await highsPromise;
  const { draw } = solveSchedule(highs, {
    archers,
    targets: options.targets ?? [1],
    details: options.details ?? ["Double"],
    config: { ...baseConfig, ...options.config },
    mode: options.mode ?? "Standard",
    vegasMode: options.vegasMode ?? false,
    existingDraw: options.existingDraw ?? [],
  });
  return draw;
}

function collegeCountsByTarget(draw) {
  const counts = new Map();
  for (const row of draw) {
    const key = `${row.Session}.${row.Target}`;
    if (!counts.has(key)) counts.set(key, new Map());
    const colleges = counts.get(key);
    colleges.set(row.College, (colleges.get(row.College) ?? 0) + 1);
  }
  return counts;
}

test("keeps physical 3s and 40 face pairs compatible", async () => {
  const archers = [
    archer("A1", { category: "advanced", college: "QUB" }),
    archer("A2", { category: "advanced", gender: "female", college: "UCC" }),
    archer("B1", { category: "beginner", college: "QUB" }),
    archer("B2", { category: "beginner", gender: "female", college: "UCC" }),
  ];
  const draw = await solve(archers);
  assert.equal(draw.length, 4);
  const faceA = new Set(draw.filter((row) => ["A", "C"].includes(row.Position)).map((row) => row["Target Face"]));
  const faceB = new Set(draw.filter((row) => ["B", "D"].includes(row.Position)).map((row) => row["Target Face"]));
  assert.equal(faceA.size, 1);
  assert.equal(faceB.size, 1);
  assert.deepEqual([...faceA], ["3s"]);
});

test("college default sessions are honoured", async () => {
  // QUB defaults to session 2; session 1 is listed first so an unweighted
  // solver would usually fill it.
  const archers = [
    archer("Q1", { college: "QUB" }),
    archer("Q2", { college: "QUB" }),
    archer("U1", { college: "UCD" }),
    archer("U2", { college: "UCD" }),
    archer("U3", { college: "UCD" }),
    archer("C1", { college: "UCC" }),
    archer("C2", { college: "UCC" }),
    archer("C3", { college: "UCC" }),
  ];
  const draw = await solve(archers, {
    targets: [1, 1],
    details: ["Double", "Double"],
    config: { default_session_by_college: { QUB: 2 } },
  });
  for (const row of draw.filter((entry) => entry.College === "QUB")) {
    assert.equal(row.Session, 2, `${row.Archer} should be in QUB's default session`);
  }
});

test("explicit session preference overrides the college default", async () => {
  const archers = [
    archer("Q1", { college: "QUB", preference: "1" }),
    archer("Q2", { college: "QUB" }),
    archer("U1", { college: "UCD" }),
    archer("U2", { college: "UCD" }),
  ];
  const draw = await solve(archers, {
    targets: [1, 1],
    details: ["Double", "Double"],
    config: { default_session_by_college: { QUB: 2 } },
  });
  assert.equal(draw.find((row) => row.Archer === "Q1 Archer").Session, 1);
});

test("clustering never outweighs the same-college triplet penalty", async () => {
  // Four RA archers could share a target, but only if three were from QUB.
  const archers = [
    archer("RA1", { college: "QUB" }),
    archer("RA2", { college: "QUB" }),
    archer("RA3", { college: "QUB" }),
    archer("RA4", { college: "UCC" }),
    archer("RI1", { category: "intermediate", college: "UCC" }),
    archer("RI2", { category: "intermediate", college: "UCC" }),
    archer("RI3", { category: "intermediate", college: "UCD" }),
    archer("RI4", { category: "intermediate", college: "UCD" }),
  ];
  const draw = await solve(archers, { targets: [2], mode: "Cluster by class" });
  for (const [target, colleges] of collegeCountsByTarget(draw)) {
    for (const [college, count] of colleges) {
      assert.ok(count < 3, `target ${target} has ${count} archers from ${college}`);
    }
  }
});

test("clusters gender-neutral classes in the configured order", async () => {
  const archers = [
    archer("RA1", { category: "advanced", college: "QUB" }),
    archer("RA2", { category: "advanced", college: "UCC" }),
    archer("RA3", { category: "advanced", gender: "female", college: "QUB" }),
    archer("RA4", { category: "advanced", gender: "female", college: "UCC" }),
    archer("RI1", { category: "intermediate", college: "QUB" }),
    archer("RI2", { category: "intermediate", college: "UCC" }),
    archer("RI3", { category: "intermediate", gender: "female", college: "QUB" }),
    archer("RI4", { category: "intermediate", gender: "female", college: "UCC" }),
  ];
  const draw = await solve(archers, { targets: [2], mode: "Cluster by class" });
  const bucketByTarget = new Map();
  for (const row of draw) {
    if (!bucketByTarget.has(row.Target)) bucketByTarget.set(row.Target, new Set());
    bucketByTarget.get(row.Target).add(row["Category Code"].slice(0, 2));
  }
  // Order is C, BB, BI, BA, RB, RI, RA: intermediate before advanced.
  assert.deepEqual([...bucketByTarget.get(1)], ["RI"]);
  assert.deepEqual([...bucketByTarget.get(2)], ["RA"]);
});

test("allows four Vegas archers on one target", async () => {
  const archers = [
    archer("V1", { category: "advanced", college: "QUB" }),
    archer("V2", { category: "advanced", college: "UCC" }),
    archer("V3", { category: "advanced", college: "QUB" }),
    archer("V4", { category: "advanced", college: "UCC" }),
  ];
  const draw = await solve(archers, { vegasMode: true });
  assert.equal(draw.filter((row) => row["Target Face"] === "Vegas").length, 4);
});

test("allows a target with zero Vegas faces", async () => {
  const archers = [
    archer("I1", { category: "intermediate", college: "QUB" }),
    archer("I2", { category: "intermediate", college: "UCC" }),
    archer("I3", { category: "intermediate", college: "QUB" }),
    archer("I4", { category: "intermediate", college: "UCC" }),
  ];
  const draw = await solve(archers, { vegasMode: true });
  assert.equal(draw.filter((row) => row["Target Face"] === "Vegas").length, 0);
});

test("preserves old slots while new archers fill another target", async () => {
  const existingArchers = [
    archer("OLD1", { college: "QUB" }),
    archer("OLD2", { college: "UCC" }),
    archer("OLD3", { college: "QUB" }),
    archer("OLD4", { college: "UCC" }),
  ];
  const oldDraw = await solve(existingArchers);
  const archers = [
    ...existingArchers,
    archer("NEW1", { college: "QUB" }),
    archer("NEW2", { college: "UCC" }),
  ];
  const draw = await solve(archers, { targets: [2], existingDraw: oldDraw });
  const newSlots = new Map(draw.map((row) => [row["Membership Number"], `${row.Session}|${row.Target}|${row.Position}`]));
  for (const row of oldDraw) {
    assert.equal(newSlots.get(row["Membership Number"]), `${row.Session}|${row.Target}|${row.Position}`);
  }
});

test("new archers still avoid same-college triplets while old targets are kept", async () => {
  const existingArchers = [
    archer("OLD1", { college: "QUB" }),
    archer("OLD2", { college: "UCC" }),
  ];
  const oldDraw = await solve(existingArchers, { targets: [1] });
  const archers = [
    ...existingArchers,
    archer("NEW1", { college: "QUB" }),
    archer("NEW2", { college: "QUB" }),
    archer("NEW3", { college: "UCC" }),
    archer("NEW4", { college: "UCC" }),
  ];
  const draw = await solve(archers, { targets: [2], existingDraw: oldDraw });
  for (const [target, colleges] of collegeCountsByTarget(draw)) {
    for (const [college, count] of colleges) {
      assert.ok(count < 3, `target ${target} has ${count} archers from ${college}`);
    }
  }
});

test("uses the configured solver time limit", () => {
  const limits = [];
  const fakeHighs = {
    withModel: (_source, callback) => callback({
      options: { set: (options) => limits.push(options.time_limit) },
      getDimensions: () => ({ numCols: 0 }),
      getColName: () => "",
      run: () => {},
      getModelStatus: () => 8,
      info: { get: () => 0 },
    }),
  };
  const archers = [archer("T1", { college: "QUB" }), archer("T2", { college: "UCC" })];
  assert.throws(() => solveSchedule(fakeHighs, {
    archers,
    targets: [1],
    details: ["Double"],
    config: { ...baseConfig, solver_time_limit_seconds: 42 },
    mode: "Standard",
    vegasMode: false,
    existingDraw: [],
  }, () => 0), /No valid draw found/);
  assert.deepEqual(limits, [42]);
});

test("copies an existing shooting-list CSV without reassigning positions", async () => {
  const archers = [
    archer("COPY1", { college: "QUB" }),
    archer("COPY2", { college: "UCC" }),
    archer("COPY3", { college: "QUB" }),
    archer("COPY4", { college: "UCC" }),
  ];
  const sourceDraw = await solve(archers);
  const table = {
    columns: DRAW_COLUMNS,
    data: sourceDraw.map((row) => DRAW_COLUMNS.map((column) => String(row[column]))),
  };
  const restored = restoreImportedDraw(table, prepareImportRoster(table));
  const originalSlots = sourceDraw.map((row) => `${row["Membership Number"]}|${row.Session}|${row.Target}|${row.Position}`).sort();
  const copiedSlots = restored.map((row) => `${row["Membership Number"]}|${row.Session}|${row.Target}|${row.Position}`).sort();
  assert.deepEqual(copiedSlots, originalSlots);
});

test("adds the minimum target needed for a 140-archer default roster", () => {
  assert.deepEqual(
    fitTargetCapacity([17, 17], ["Double", "Double"], 140),
    [18, 17],
  );
  assert.deepEqual(
    fitTargetCapacity([17, 17], ["Double", "Double"], 136),
    [17, 17],
  );
});
