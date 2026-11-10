import {
  isSpecial,
  makeDrawRow,
  parseSessionPreferences,
  sortDraw,
} from "./roster.js";

// Cluster-by-class target order used by app.py.
const CLASS_ORDER = ["C", "BB", "BI", "BA", "RB", "RI", "RA"];

const clean = (value) => String(value ?? "").trim();

function sessionEligible(archer, sessionNumber, config) {
  const day = String(config.session_days?.[String(sessionNumber)] ?? "").toLowerCase();
  if (!day || ["both days", "no h2h"].includes(archer["Which Days"])) return true;
  if (archer["Which Days"] === "saturday only") return day.includes("saturday");
  if (archer["Which Days"] === "sunday only") return day.includes("sunday");
  return false;
}

function defaultSession(archer, config) {
  if (parseSessionPreferences(archer["Session Preference"]).length) return null;
  const college = archer.College.toUpperCase();
  if ((config.malleable_colleges ?? []).map((value) => String(value).toUpperCase()).includes(college)) {
    return null;
  }
  const defaults = Object.fromEntries(
    Object.entries(config.default_session_by_college ?? {}).map(([key, value]) => [
      key.toUpperCase(), Number(value),
    ]),
  );
  return defaults[college] ?? null;
}

function addConstraint(model, name, bounds) {
  model.constraints[name] = bounds;
}

function addVariable(model, name, objective = 0, integer = false) {
  model.variables[name] = { score: objective };
  if (integer) model.ints[name] = 1;
  else model.binaries[name] = 1;
}

function addTerm(model, variable, constraint, coefficient) {
  model.variables[variable][constraint] =
    (model.variables[variable][constraint] ?? 0) + coefficient;
}

function bucketFor(code) {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) return "Other";
  return normalized.startsWith("C") ? "C" : normalized.slice(0, 2);
}

function positionFor(detail) {
  return detail === "Single" ? ["A", "B"] : ["A", "B", "C", "D"];
}

export function fitTargetCapacity(targets, details, archerCount, maxTargets = 200) {
  const adjusted = [...targets];
  const capacity = () => adjusted.reduce(
    (total, count, index) => total + count * (details[index] === "Double" ? 4 : 2),
    0,
  );
  if (!adjusted.length || capacity() >= archerCount) return adjusted;

  const positions = details[0] === "Double" ? 4 : 2;
  const shortage = archerCount - capacity();
  adjusted[0] = Math.min(maxTargets, adjusted[0] + Math.ceil(shortage / positions));
  return adjusted;
}

// Objective weights mirror solve_schedule() in app.py.
export const CLUB_TRIPLET_PENALTY = 10_000_000;
export const COLLEGE_DEFAULT_SCORE = 10_000;
export const CLUSTER_THRESHOLD_SCALE = 1000;
const CLUSTER_THRESHOLDS = [[2, 1], [3, 2], [4, 3]];

function sortedBuckets(archers) {
  return [...new Set(archers.map((archer) => bucketFor(archer._code)))].sort((left, right) => {
    const leftRank = CLASS_ORDER.indexOf(left);
    const rightRank = CLASS_ORDER.indexOf(right);
    return (leftRank < 0 ? CLASS_ORDER.length : leftRank)
      - (rightRank < 0 ? CLASS_ORDER.length : rightRank)
      || left.localeCompare(right);
  });
}

// Previous allocations keyed by archer index, matched only by membership
// numbers that are unique in both the old draw and the current roster.
function previousTargets(existingDraw, archers) {
  const oldCounts = new Map();
  const newCounts = new Map();
  for (const row of existingDraw) {
    const member = clean(row["Membership Number"]);
    if (member) oldCounts.set(member, (oldCounts.get(member) ?? 0) + 1);
  }
  for (const archer of archers) {
    const member = clean(archer["Membership Number"]);
    if (member) newCounts.set(member, (newCounts.get(member) ?? 0) + 1);
  }
  const indexByMember = new Map(archers.map((archer, index) => [clean(archer["Membership Number"]), index]));
  const previous = new Map();
  for (const row of existingDraw) {
    const member = clean(row["Membership Number"]);
    if (!member || oldCounts.get(member) !== 1 || newCounts.get(member) !== 1) continue;
    previous.set(indexByMember.get(member), {
      session: Number(row.Session) - 1,
      target: Number(row.Target) - 1,
    });
  }
  return previous;
}

function withSolveFaces(archers, faceOverrides, vegasMode) {
  return archers.map((archer, index) => {
    const face = String(faceOverrides[index] ?? archer._face).trim().toLowerCase();
    if (face === "vegas" && vegasMode) return { ...archer, _solveFace: "3s" };
    if (face !== "3s" && face !== "40") {
      throw new Error(`Unexpected target face type ${JSON.stringify(faceOverrides[index] ?? archer._face)} for archer row ${index}.`);
    }
    return { ...archer, _solveFace: face };
  });
}

export function fullCapacityParityMessage(archerCount, threeS) {
  return `Every place is filled (${archerCount} archers) and ${threeS} of them shoot 3s faces. `
    + "A full target holds an even number of 3s archers, so no valid draw exists. "
    + "Add a target or change the session setup.";
}

// The impossible draw the solver would reject: all places filled with an
// odd number of 3s archers outside Vegas mode.
export function fullCapacityParityProblem(archers, targets, details, vegasMode) {
  if (vegasMode) return null;
  const places = targets.reduce((sum, count, index) => sum + count * positionFor(details[index]).length, 0);
  const threeS = archers.filter((archer) => archer._face === "3s").length;
  return places === archers.length && threeS % 2 === 1
    ? fullCapacityParityMessage(archers.length, threeS)
    : null;
}

// Chooses a target for every archer; drawFromTargetSolution then places
// lanes so that 3s archers share the A/C face and 40s the B/D face.
export function createTargetScheduleModel({
  archers,
  targets,
  details,
  config,
  mode = "Campanile",
  vegasMode = false,
  existingDraw = [],
  preserveExistingHard = false,
  forcedSessions = {},
  faceOverrides = {},
}) {
  // Face overrides (from "Swap target face type") replace the roster face
  // for the face rules but, as in app.py, not for the qualifying rule.
  archers = withSolveFaces(archers, faceOverrides, vegasMode);
  const archerCount = archers.length;
  const sessionCount = targets.length;
  const clustering = mode === "Cluster by class";
  const campanile = mode === "Campanile";
  const capacities = targets.map((count, index) => count * positionFor(details[index]).length);
  const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
  if (totalCapacity < archerCount) {
    throw new Error(`Only ${totalCapacity} places for ${archerCount} archers.`);
  }

  const colleges = [...new Set(archers.map((archer) => archer.College.toUpperCase()))].sort();
  if (colleges.length < 2) {
    throw new Error("Every target needs archers from at least two colleges; add a second college to the roster.");
  }

  const preferences = archers.map((archer) => parseSessionPreferences(archer["Session Preference"]));
  for (let archer = 0; archer < archerCount; archer += 1) {
    const invalid = preferences[archer].filter((session) => session < 1 || session > sessionCount);
    if (invalid.length) {
      throw new Error(`${archers[archer]._name} requested invalid session(s): ${invalid.join(", ")}`);
    }
  }
  for (let session = 0; session < sessionCount; session += 1) {
    const wanted = preferences.reduce((sum, sessions) => sum + Number(sessions.includes(session + 1)), 0);
    if (wanted > capacities[session]) {
      throw new Error(`${wanted} archers requested session ${session + 1}, but it has only ${capacities[session]} places.`);
    }
  }
  const threeS = archers.filter((archer) => archer._solveFace === "3s").length;
  if (!vegasMode && totalCapacity === archerCount && threeS % 2 === 1) {
    throw new Error(fullCapacityParityMessage(archerCount, threeS));
  }
  if (!archers.some(isSpecial)) {
    throw new Error("No qualifying archers exist for the special target-block rule.");
  }

  const model = {
    optimize: "score",
    opType: "max",
    constraints: {},
    variables: {},
    binaries: {},
    ints: {},
  };
  const assignmentVars = new Map();
  const tripletVariables = [];
  const clusterVariables = [];
  const previous = previousTargets(existingDraw, archers);
  const buckets = sortedBuckets(archers);
  const bucketRank = new Map(buckets.map((bucket, rank) => [bucket, rank]));
  const collegeDefaults = archers.map((archer) => defaultSession(archer, config));
  const maxTargets = Math.max(...targets);

  // Upper bounds of every secondary objective term, used to make one more
  // preserved allocation outweigh all of them, as app.py does.
  let tripletBound = 0;
  let clusterBound = 0;
  let preferenceBound = 0;
  let orderBound = 0;

  for (let archer = 0; archer < archerCount; archer += 1) {
    const assignConstraint = `target_assign_${archer}`;
    addConstraint(model, assignConstraint, { equal: 1 });
    const fixed = preserveExistingHard ? previous.get(archer) : null;
    const wantedSession = collegeDefaults[archer];
    if (wantedSession !== null && wantedSession >= 1 && wantedSession <= sessionCount) {
      preferenceBound += COLLEGE_DEFAULT_SCORE;
    }
    const orderWeightPerTarget = 100 * (buckets.length - (bucketRank.get(bucketFor(archers[archer]._code)) ?? 0));
    if (clustering) orderBound += orderWeightPerTarget * maxTargets;

    for (let session = 0; session < sessionCount; session += 1) {
      const sessionNumber = session + 1;
      const explicit = preferences[archer];
      if (explicit.length && !explicit.includes(sessionNumber)) continue;
      const forced = forcedSessions[archer];
      if (forced !== undefined && Number(forced) !== sessionNumber) continue;
      if (!sessionEligible(archers[archer], sessionNumber, config)) continue;
      for (let target = 0; target < targets[session]; target += 1) {
        if (fixed && (fixed.session !== session || fixed.target !== target)) continue;
        const variable = `t_${archer}_${session}_${target}`;
        let score = wantedSession === sessionNumber ? COLLEGE_DEFAULT_SCORE : 0;
        if (clustering) score += orderWeightPerTarget * (targets[session] - target);
        addVariable(model, variable, score);
        addTerm(model, variable, assignConstraint, 1);
        assignmentVars.set(`${archer}|${session}|${target}`, variable);
      }
    }
  }

  for (let session = 0; session < sessionCount; session += 1) {
    const capacity = positionFor(details[session]).length;
    for (let target = 0; target < targets[session]; target += 1) {
      const members = [];
      for (let archer = 0; archer < archerCount; archer += 1) {
        const variable = assignmentVars.get(`${archer}|${session}|${target}`);
        if (variable) members.push({ archer, variable });
      }
      const key = `${session}_${target}`;
      const addRow = (name, bounds, terms) => {
        addConstraint(model, name, bounds);
        for (const [variable, coefficient] of terms) addTerm(model, variable, name, coefficient);
      };
      const memberTerms = (predicate) => members
        .filter(({ archer }) => predicate(archers[archer]))
        .map(({ variable }) => [variable, 1]);

      addRow(`capacity_${key}`, { max: capacity }, memberTerms(() => true));
      addRow(`qualifying_${key}`, { min: 1 }, memberTerms(isSpecial));
      if (campanile) {
        addRow(`campanile_${key}`, { min: 1 }, memberTerms((row) => row.Category !== "beginner"));
      }
      if (vegasMode) {
        addRow(`vegas_limit_${key}`, { max: 4 }, memberTerms((row) => row._solveFace === "3s"));
      }

      const presence = [];
      for (let collegeIndex = 0; collegeIndex < colleges.length; collegeIndex += 1) {
        const college = colleges[collegeIndex];
        const present = `college_${key}_${collegeIndex}`;
        addVariable(model, present);
        presence.push(present);
        const collegeTerms = memberTerms((row) => row.College.toUpperCase() === college);
        addRow(`college_min_${key}_${collegeIndex}`, { min: 0 }, [...collegeTerms, [present, -1]]);
        addRow(`college_max_${key}_${collegeIndex}`, { max: 0 }, [...collegeTerms, [present, -capacity]]);

        // Soft rule: avoid three or more archers from one college.
        if (capacity >= 3 && collegeTerms.length >= 3) {
          const triplet = `triplet_${key}_${collegeIndex}`;
          addVariable(model, triplet, -CLUB_TRIPLET_PENALTY);
          tripletVariables.push(triplet);
          addRow(`${triplet}_upper`, { max: 2 }, [...collegeTerms, [triplet, -capacity]]);
          addRow(`${triplet}_lower`, { max: 0 }, [...collegeTerms.map(([variable]) => [variable, -1]), [triplet, 3]]);
        }
      }
      // At most one college can reach three archers on a target.
      if (capacity >= 3) tripletBound += CLUB_TRIPLET_PENALTY;
      addRow(`college_count_${key}`, { min: 2 }, presence.map((variable) => [variable, 1]));

      if (!vegasMode) {
        const faceKeys = details[session] === "Single" ? ["A"] : ["A", "B"];
        const face3 = [];
        const face40 = [];
        for (const faceKey of faceKeys) {
          const three = `face3_${key}_${faceKey}`;
          const forty = `face40_${key}_${faceKey}`;
          addVariable(model, three);
          addVariable(model, forty);
          addRow(`face_exclusive_${key}_${faceKey}`, { max: 1 }, [[three, 1], [forty, 1]]);
          face3.push(three);
          face40.push(forty);
        }
        if (faceKeys.length === 2) {
          // If B/D is a 3s face, A/C must be one too.
          addRow(`face_order_${key}`, { max: 0 }, [[face3[1], 1], [face3[0], -1]]);
        }
        const lanesPerFace = capacity / faceKeys.length;
        addRow(`face3_lanes_${key}`, { max: 0 }, [
          ...memberTerms((row) => row._solveFace === "3s"),
          ...face3.map((variable) => [variable, -lanesPerFace]),
        ]);
        addRow(`face40_lanes_${key}`, { max: 0 }, [
          ...memberTerms((row) => row._solveFace === "40"),
          ...face40.map((variable) => [variable, -lanesPerFace]),
        ]);
      }

      if (clustering) {
        clusterBound += CLUSTER_THRESHOLDS
          .filter(([threshold]) => threshold <= capacity)
          .reduce((sum, [, weight]) => sum + weight, 0);
        for (const bucket of buckets) {
          const bucketTerms = memberTerms((row) => bucketFor(row._code) === bucket);
          for (const [threshold, weight] of CLUSTER_THRESHOLDS) {
            if (threshold > capacity || bucketTerms.length < threshold) continue;
            // Indicator can be 1 only when the bucket has `threshold` archers here.
            const indicator = `cluster_${key}_${bucket}_${threshold}`;
            addVariable(model, indicator, weight * CLUSTER_THRESHOLD_SCALE);
            clusterVariables.push(indicator);
            addRow(`${indicator}_min`, { min: 0 }, [...bucketTerms, [indicator, -threshold]]);
          }
        }
      }
    }
  }

  const preservedVariables = [];
  for (const [archer, slot] of previous) {
    const variable = assignmentVars.get(`${archer}|${slot.session}|${slot.target}`);
    if (variable) preservedVariables.push(variable);
  }
  const lowerTierBound = preferenceBound + CLUSTER_THRESHOLD_SCALE * clusterBound + orderBound;
  const preservationWeight = tripletBound + lowerTierBound + 1;
  if (!preserveExistingHard) {
    for (const variable of preservedVariables) model.variables[variable].score += preservationWeight;
  }

  return {
    model,
    assignmentVars: Object.fromEntries(assignmentVars),
    capacities,
    preservedVariables,
    preservationWeight,
    tripletVariables,
    clusterVariables,
    // True when one triplet outweighs every college-default and clustering
    // score combined, so the objective can be solved tier by tier.
    tripletsDominate: CLUB_TRIPLET_PENALTY > lowerTierBound,
  };
}

export function drawFromTargetSolution({
  solution, assignmentVars, archers, details, vegasMode, existingDraw = [], faceOverrides = {},
}) {
  archers = withSolveFaces(archers, faceOverrides, vegasMode);
  const targets = new Map();
  for (const [key, variable] of Object.entries(assignmentVars)) {
    if (Number(solution[variable] ?? 0) < 0.5) continue;
    const [archerIndex, session, target] = key.split("|").map(Number);
    const targetKey = `${session}|${target}`;
    if (!targets.has(targetKey)) targets.set(targetKey, []);
    targets.get(targetKey).push({ archerIndex, archer: archers[archerIndex] });
  }

  const previousPositions = new Map();
  for (const row of existingDraw) {
    const member = clean(row["Membership Number"]);
    if (member) previousPositions.set(member, row);
  }
  const draw = [];
  for (const [targetKey, members] of targets) {
    const [session, target] = targetKey.split("|").map(Number);
    const positionByArcher = new Map();
    // Keep each archer's previous lane when it is still allowed.
    const assign = (group, allowed) => {
      const available = [...allowed];
      for (const item of group) {
        const prior = previousPositions.get(item.archer["Membership Number"]);
        if (prior && Number(prior.Session) === session + 1 && Number(prior.Target) === target + 1) {
          const index = available.indexOf(clean(prior.Position).toUpperCase());
          if (index >= 0) positionByArcher.set(item.archerIndex, available.splice(index, 1)[0]);
        }
      }
      for (const item of group) {
        if (positionByArcher.has(item.archerIndex)) continue;
        const next = available.shift();
        if (!next) throw new Error(`Could not assign a lane at session ${session + 1}, target ${target + 1}.`);
        positionByArcher.set(item.archerIndex, next);
      }
    };

    if (vegasMode || details[session] === "Single") {
      assign(members, positionFor(details[session]));
    } else {
      const threeS = members.filter((item) => item.archer._solveFace === "3s");
      const forty = members.filter((item) => item.archer._solveFace === "40");
      if (threeS.length && forty.length) {
        assign(threeS, ["A", "C"]);
        assign(forty, ["B", "D"]);
      } else {
        assign(members, ["A", "C", "B", "D"]);
      }
    }

    for (const { archerIndex, archer } of members) {
      const face = vegasMode && archer._solveFace === "3s" ? "Vegas" : archer._solveFace;
      draw.push(makeDrawRow(archer, session + 1, target + 1, positionByArcher.get(archerIndex), face));
    }
  }
  return sortDraw(draw);
}

export function modelToLinearProgram(model) {
  const variables = Object.entries(model.variables);
  const rowsByConstraint = new Map();
  const objectiveTerms = [];
  for (const [name, data] of variables) {
    objectiveTerms.push([name, data.score ?? 0]);
    for (const [constraint, coefficient] of Object.entries(data)) {
      if (constraint === "score" || coefficient === 0) continue;
      if (!rowsByConstraint.has(constraint)) rowsByConstraint.set(constraint, []);
      rowsByConstraint.get(constraint).push([name, coefficient]);
    }
  }

  const expression = (terms) => {
    const nonzero = terms.filter(([, coefficient]) => coefficient !== 0);
    if (!nonzero.length) return "0";
    return nonzero.map(([name, coefficient], index) => {
      const magnitude = Math.abs(coefficient);
      const sign = coefficient < 0 ? "-" : "+";
      const prefix = index === 0 && sign === "+" ? "" : `${sign} `;
      return `${prefix}${magnitude === 1 ? "" : `${magnitude} `}${name}`;
    }).join(" ");
  };

  const objective = expression(objectiveTerms);
  const rows = [];
  for (const [name, bounds] of Object.entries(model.constraints)) {
    const row = expression(rowsByConstraint.get(name) ?? []);
    if (bounds.equal !== undefined) rows.push(` ${name}: ${row} = ${bounds.equal}`);
    else {
      if (bounds.min !== undefined) rows.push(` ${name}_min: ${row} >= ${bounds.min}`);
      if (bounds.max !== undefined) rows.push(` ${name}_max: ${row} <= ${bounds.max}`);
    }
  }
  const binaries = Object.keys(model.binaries ?? {});
  const integers = Object.keys(model.ints ?? {});
  return [
    "Maximize",
    ` objective: ${objective}`,
    "Subject To",
    ...rows,
    ...(binaries.length ? ["Binaries", ...binaries.map((name) => ` ${name}`)] : []),
    ...(integers.length ? ["Generals", ...integers.map((name) => ` ${name}`)] : []),
    "End",
  ].join("\n");
}

export function validateDraw(draw, archers, details, vegasMode, options = {}) {
  const slots = new Set();
  const assigned = new Set();
  const grouped = new Map();
  for (const row of draw) {
    const slot = `${row.Session}|${row.Target}|${row.Position}`;
    if (slots.has(slot)) throw new Error(`Position ${row.Session}.${row.Target}${row.Position} was assigned twice.`);
    slots.add(slot);
    const member = String(row["Membership Number"]);
    if (assigned.has(member)) throw new Error(`Archer ${member} received more than one assignment.`);
    assigned.add(member);
    const targetKey = `${row.Session}|${row.Target}`;
    if (!grouped.has(targetKey)) grouped.set(targetKey, []);
    grouped.get(targetKey).push(row);
  }
  if (options.requireFullRoster !== false && assigned.size !== archers.length) {
    throw new Error("Not every archer received exactly one assignment.");
  }

  for (const [key, rows] of grouped) {
    const colleges = new Set(rows.map((row) => row.College));
    if (options.requireCollegeMix !== false && colleges.size < 2) {
      throw new Error(`Target ${key.replace("|", ".")} has fewer than two colleges.`);
    }
    const vegasCount = rows.filter((row) => row["Target Face"] === "Vegas").length;
    if (vegasMode && vegasCount > 4) throw new Error(`Target ${key.replace("|", ".")} has more than four Vegas archers.`);
    const [session, target] = key.split("|").map(Number);
    const double = details[session - 1] === "Double";
    const facePairs = double ? [["A", "C"], ["B", "D"]] : [["A", "B"]];
    for (const pair of facePairs) {
      const faces = new Set(rows
        .filter((row) => pair.includes(row.Position) && row["Target Face"] !== "Vegas")
        .map((row) => row["Target Face"]));
      if (faces.size > 1) throw new Error(`Target ${session}.${target} has incompatible physical face assignments.`);
    }
  }
  return true;
}
