import { parseAllocation } from "./edits.js";
import {
  createTargetScheduleModel,
  drawFromTargetSolution,
  modelToLinearProgram,
  validateDraw,
} from "./scheduler.js";

const MIN_PASS_SECONDS = 5;

const STATUS_NAMES = { 7: "Optimal", 8: "Infeasible", 13: "Time limit reached" };
const PRIMAL_FEASIBLE = 2;

// Solves `model`, optionally seeded with a feasible `start` (variable name
// to value), and returns the solution by variable name when one was found.
function runHighs(highs, model, timeLimit, start = null) {
  return highs.withModel({ format: "lp", data: modelToLinearProgram(model) }, (solver) => {
    solver.options.set({
      output_flag: false,
      presolve: "on",
      // Like CP-SAT in app.py, search for the true optimum until the time
      // limit: a relative gap would let the large preservation and penalty
      // weights hide the smaller college-default and clustering terms.
      mip_rel_gap: 0,
      mip_abs_gap: 0.5,
      time_limit: Math.max(MIN_PASS_SECONDS, timeLimit),
    });
    const { numCols } = solver.getDimensions();
    const names = Array.from({ length: numCols }, (_, index) => solver.getColName(index));
    if (start) {
      solver.setSolution({ colValue: Float64Array.from(names, (name) => Math.round(start[name] ?? 0)) });
    }
    solver.run();
    const code = solver.getModelStatus();
    const result = { Status: STATUS_NAMES[code] ?? `HiGHS status ${code}` };
    if (Number(solver.info.get("primal_solution_status")) !== PRIMAL_FEASIBLE) {
      return { result, solution: null };
    }
    result.ObjectiveValue = solver.getObjectiveValue();
    const { colValue } = solver.getSolution();
    const solution = Object.fromEntries(names.map((name, index) => [name, colValue[index]]));
    return { result, solution };
  });
}

const countSet = (solution, variables) =>
  variables.reduce((sum, variable) => sum + Number((solution[variable] ?? 0) >= 0.5), 0);

function addCut(model, name, variables, bounds) {
  model.constraints[name] = bounds;
  for (const variable of variables) model.variables[variable][name] = 1;
}

function rowTerms(model) {
  const rows = new Map();
  for (const [name, data] of Object.entries(model.variables)) {
    for (const [row, coefficient] of Object.entries(data)) {
      if (row === "score") continue;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push([name, coefficient]);
    }
  }
  return rows;
}

// A stage that does not reward clustering leaves its indicators at zero;
// switch on every indicator whose threshold the assignment already meets.
function completeIndicators(solution, clusterVariables, rows) {
  const completed = { ...solution };
  for (const indicator of clusterVariables) {
    const activity = rows.get(`${indicator}_min`).reduce((sum, [name, coefficient]) =>
      sum + coefficient * (name === indicator ? 1 : Math.round(completed[name] ?? 0)), 0);
    completed[indicator] = activity >= 0 ? 1 : 0;
  }
  return completed;
}

const objectiveValue = (model, solution) => Object.entries(model.variables)
  .reduce((sum, [name, data]) => sum + (data.score ?? 0) * Math.round(solution[name] ?? 0), 0);

// The app.py objective is lexicographic: preserved allocations, then
// same-college triplets, then college defaults and clustering. Solving it in
// stages gives the same optimum as the single weighted objective once the
// top-tier stage is proven optimal, and finds good draws far faster:
//   1. preserved allocations and triplets only, locked in as cuts;
//   2. (cluster mode) everything except the weak threshold indicators;
//   3. the full objective, seeded with the best draw so far.
// The best draw under the full app.py objective is returned.
function solveTiered(highs, schedule, remaining) {
  const { model, preservedVariables, tripletVariables, clusterVariables, tripletsDominate } = schedule;
  const full = structuredClone(model);
  const rows = rowTerms(model);
  let best = null;
  const consider = (stage) => {
    if (!stage.solution) return;
    const solution = completeIndicators(stage.solution, clusterVariables, rows);
    const value = objectiveValue(model, solution);
    if (!best || value > best.value) best = { result: stage.result, solution, value };
  };

  if (preservedVariables.length || (tripletsDominate && tripletVariables.length)) {
    const tier = structuredClone(model);
    for (const variable of Object.values(tier.variables)) variable.score = 0;
    const tripletWeight = tripletsDominate ? 1 : 0;
    for (const variable of tripletVariables) tier.variables[variable].score = -tripletWeight;
    for (const variable of preservedVariables) {
      tier.variables[variable].score = tripletWeight * tripletVariables.length + 1;
    }
    const top = runHighs(highs, tier, remaining() / 3);
    consider(top);
    if (top.solution) {
      addCut(full, "tier_preserved", preservedVariables, {
        min: countSet(top.solution, preservedVariables),
      });
      if (tripletsDominate && top.result.Status === "Optimal") {
        addCut(full, "tier_triplets", tripletVariables, {
          max: countSet(top.solution, tripletVariables),
        });
      }
    }
  }

  if (clusterVariables.length) {
    const linear = structuredClone(full);
    for (const variable of clusterVariables) linear.variables[variable].score = 0;
    consider(runHighs(highs, linear, remaining() / 2, best?.solution));
  }

  const complete = runHighs(highs, full, remaining(), best?.solution);
  consider(complete);
  if (!best) return complete;
  // Only the full-objective stage can prove the draw optimal.
  const proven = complete.result.Status === "Optimal";
  return {
    ...best,
    result: { Status: proven ? "Optimal" : "Time limit reached", ObjectiveValue: best.value },
  };
}

function runPass(highs, data, preserveExistingHard, remaining) {
  const schedule = createTargetScheduleModel({ ...data, preserveExistingHard });
  const { result, solution } = solveTiered(highs, schedule, remaining);
  if (!solution) return { schedule, result, draw: null };
  const draw = drawFromTargetSolution({
    solution,
    assignmentVars: schedule.assignmentVars,
    archers: data.archers,
    details: data.details,
    vegasMode: data.vegasMode,
    existingDraw: data.existingDraw,
    faceOverrides: data.faceOverrides,
  });
  validateDraw(draw, data.archers, data.details, data.vegasMode);
  return { schedule, result, draw };
}

// Solves within config.solver_time_limit_seconds, the same budget as app.py.
// With an existing draw, a first pass pins every unchanged archer to their
// previous target. When that is feasible it gives the same draw as the soft
// preservation objective, which is the fallback when it is not.
export function solveSchedule(highs, data, now = () => Date.now()) {
  const budget = Number(data.config?.solver_time_limit_seconds ?? 60);
  const started = now();
  const remaining = () => budget - (now() - started) / 1000;
  let preserveError = null;

  if (data.existingDraw?.length) {
    try {
      const pass = runPass(highs, data, true, remaining);
      if (pass.draw) return { ...pass, preservedFirst: true };
      preserveError = new Error(`Fixed-target pass returned ${pass.result.Status}.`);
    } catch (error) {
      preserveError = error;
    }
  }

  const pass = runPass(highs, data, false, remaining);
  if (pass.draw) return { ...pass, preservedFirst: false };

  const detail = preserveError ? ` Fixed-target pass: ${preserveError.message}` : "";
  throw new Error(
    "No valid draw found. Review target capacity, face types, "
    + `session restrictions and target-block requirements.${detail}`,
  );
}

// CP-SAT status names, as app.py reports them.
export const statusName = (result) => (result.Status === "Optimal" ? "OPTIMAL" : "FEASIBLE");

// target_face_swaps: moves each requested archer to the opposite face type.
// Tries all changes together, then only 40 -> 3s, then only 3s -> 40, each
// from the original draw; the first feasible schedule wins.
export function targetFaceSwaps(highs, { draw, allocations, ...data }) {
  const requested = [];
  const seen = new Set();
  for (const allocation of allocations) {
    const { session, target, position } = parseAllocation(allocation);
    const key = `${session}|${target}|${position}`;
    if (seen.has(key)) throw new Error(`Allocation ${allocation} was listed more than once.`);
    seen.add(key);
    const matches = draw
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.Session === session && row.Target === target && row.Position === position);
    if (matches.length !== 1) throw new Error(`No uniquely allocated archer found at ${allocation}.`);
    requested.push(matches[0].index);
  }
  if (!requested.length) throw new Error("Select at least one archer to swap.");

  const changes = { "40_to_3s": [], "3s_to_40": [] };
  for (const index of requested) {
    const face = String(draw[index]["Target Face"]).trim();
    if (["3s", "vegas"].includes(face.toLowerCase())) changes["3s_to_40"].push(index);
    else if (face === "40") changes["40_to_3s"].push(index);
    else throw new Error(`Unexpected target face type ${JSON.stringify(face)}.`);
  }

  const attempts = [
    ["both", ["40_to_3s", "3s_to_40"]],
    ["40_to_3s", ["40_to_3s"]],
    ["3s_to_40", ["3s_to_40"]],
  ];
  const failures = [];
  const outcomes = new Map();
  for (const [name, directions] of attempts) {
    const trialDraw = draw.map((row) => ({ ...row }));
    const overridden = [];
    for (const direction of directions) {
      for (const index of changes[direction]) {
        trialDraw[index]["Target Face"] = direction === "40_to_3s" ? "3s" : "40";
        overridden.push(index);
      }
    }
    if (!overridden.length) continue;

    const faceOverrides = {};
    for (const index of overridden) {
      const original = draw[index];
      const matches = data.archers
        .map((archer, archerIndex) => ({ archer, archerIndex }))
        .filter(({ archer }) => archer._name === String(original.Archer)
          && String(archer["Membership Number"]) === String(original["Membership Number"]));
      if (matches.length !== 1) {
        throw new Error("Cannot uniquely match the selected archer to the solver roster. "
          + "Use a stable per-archer row identifier to support duplicate names and IDs.");
      }
      faceOverrides[matches[0].archerIndex] = trialDraw[index]["Target Face"];
    }

    // An attempt identical to an earlier one has the same outcome.
    const signature = JSON.stringify(Object.entries(faceOverrides).sort());
    let outcome = outcomes.get(signature);
    if (!outcome) {
      try {
        outcome = { solved: solveSchedule(highs, { ...data, existingDraw: trialDraw, faceOverrides }) };
      } catch (error) {
        outcome = { error };
      }
      outcomes.set(signature, outcome);
    }
    if (outcome.solved) return { ...outcome.solved, failures };
    failures.push(`${name} attempt failed: ${outcome.error.message}`);
  }
  throw new Error(`No valid schedule could accommodate the requested face changes. ${failures.join(" | ")}`);
}
