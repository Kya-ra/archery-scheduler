// Persistent target-face overrides, keyed by membership number. An override
// records a face that differs from the one derived from the archer's bow,
// category and gender. It applies to every later solve until those fields
// change or the archer is removed. (app.py applies a face swap to one solve
// only.)
import { clean, normalizeRoster } from "./roster.js";

const FACE_FIELDS = ["Bow Type", "Category", "Gender"];

// "Vegas" is the 3s face shot under Vegas mode.
export const solverFace = (face) => (clean(face).toLowerCase() === "40" ? "40" : "3s");

const derivedFaces = (roster) =>
  new Map(normalizeRoster(roster).map((archer) => [archer["Membership Number"], archer._face]));

// Returns overrides with `member` set to `face`, or cleared when `face` is
// the archer's derived face.
export function setOverride(overrides, roster, member, face) {
  const next = { ...overrides };
  const derived = derivedFaces(roster).get(member);
  if (derived === undefined || solverFace(face) === derived) delete next[member];
  else next[member] = solverFace(face);
  return next;
}

// Drops overrides of archers who left the roster or whose bow, category or
// gender changed between `previous` and `next`.
export function reconcileOverrides(previous, next, overrides) {
  const fields = (roster) => new Map(roster.map((archer) => [
    clean(archer["Membership Number"]),
    FACE_FIELDS.map((field) => clean(archer[field]).toLowerCase()).join("|"),
  ]));
  const before = fields(previous);
  const after = fields(next);
  const kept = {};
  for (const [member, face] of Object.entries(overrides)) {
    if (!after.has(member)) continue;
    if (before.has(member) && before.get(member) !== after.get(member)) continue;
    kept[member] = face;
  }
  return kept;
}

// Overrides implied by a copied schedule: every recorded face that differs
// from the roster's derived face.
export function overridesFromDraw(draw, roster) {
  let overrides = {};
  for (const row of draw) overrides = setOverride(overrides, roster, clean(row["Membership Number"]), row["Target Face"]);
  return overrides;
}

// The solver's form: overrides keyed by index into the normalised roster.
export function indexedOverrides(archers, overrides) {
  const indexed = {};
  archers.forEach((archer, index) => {
    const face = overrides[archer["Membership Number"]];
    if (face) indexed[index] = face;
  });
  return indexed;
}
