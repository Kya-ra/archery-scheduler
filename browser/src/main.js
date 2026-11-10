import Papa from "papaparse";
import eventConfig from "../../config.json";
import {
  IANSEO_COLUMNS,
  REQUIRED,
  importedCapacity,
  mergeRoster,
  normalizeRoster,
  prepareImportRoster,
  readEntryFile,
  restoreImportedDraw,
  rosterRecord,
  validateImportedRoster,
} from "./roster.js";
import { fitTargetCapacity, fullCapacityParityProblem, tooManyTargetsProblem } from "./scheduler.js";
import {
  applySessionPreference,
  archerAllocationLabel,
  batchSessionChanges,
  classSwaps,
  deleteAllocation,
  deleteArcher,
  duplicateArcher,
  editArcher,
  incompatibleFaces,
  parseAllocation,
  refreshSummary,
  swapDestinations,
  swapTargetBlockNumbers,
  swapWithDestination,
} from "./edits.js";
import {
  HTH_COLUMNS,
  SUMMARY_COLUMNS,
  classCountRows,
  headToHeads,
  ianseoImportRows,
  ianseoText,
  shootingListCsv,
  workbookBytes,
} from "./exports.js";
import {
  indexedOverrides,
  overridesFromDraw,
  reconcileOverrides,
  setOverride,
} from "./overrides.js";
import "./styles.css";

const $ = (selector) => document.querySelector(selector);
const elements = {
  file: $("#roster-file"),
  uploadZone: $("#upload-zone"),
  uploadTitle: $("#upload-title"),
  uploadSubtitle: $("#upload-subtitle"),
  importMode: document.querySelectorAll("input[name='import-mode']"),
  rosterStatus: $("#roster-status"),
  rosterPreview: $("#roster-preview"),
  template: $("#download-template"),
  clearAll: $("#clear-all"),
  sessionCount: $("#session-count"),
  sessionConfigs: $("#session-configs"),
  totalCapacity: $("#total-capacity"),
  generate: $("#generate-button"),
  runNote: $("#run-note"),
  mode: document.querySelectorAll("input[name='grouping']"),
  vegas: $("#vegas-mode"),
  notice: $("#notice"),
  emptyCanvas: $("#empty-canvas"),
  rosterSection: $("#roster-section"),
  rosterSummaryTitle: $("#roster-summary-title"),
  rosterTable: $("#roster-table"),
  scheduleContent: $("#schedule-content"),
  resultActions: $("#result-actions"),
  status: $("#solver-status"),
  download: $("#download-draw"),
  downloadWorkbook: $("#download-workbook"),
  resultsTitle: $("#results-title"),
  resultsSubtitle: $("#results-subtitle"),
  metrics: $("#metrics-strip"),
  sessionSummary: $("#session-summary"),
  classCounts: $("#class-counts"),
  sessions: $("#sessions-output"),
  drawCount: $("#draw-count"),
  theme: $("#theme-toggle"),
  editForm: $("#edit-archer-form"),
  editTitle: $("#edit-archer-title"),
  editFields: $("#edit-archer-fields"),
  cancelEdit: $("#cancel-edit"),
  duplicateForm: $("#duplicate-form"),
  duplicateSource: $("#duplicate-source"),
  duplicateDestination: $("#duplicate-destination"),
  duplicateNote: $("#duplicate-note"),
  duplicateSubmit: $("#duplicate-submit"),
  deleteForm: $("#delete-form"),
  deleteMode: document.querySelectorAll("input[name='delete-mode']"),
  deleteAllocation: $("#delete-allocation"),
  deleteAllocationLabel: $("#delete-allocation-label"),
  deleteArcher: $("#delete-archer"),
  deleteArcherLabel: $("#delete-archer-label"),
  deleteSubmit: $("#delete-submit"),
  batchForm: $("#batch-form"),
  batchText: $("#batch-text"),
  swapForm: $("#swap-form"),
  swapMember: $("#swap-member"),
  swapMode: document.querySelectorAll("input[name='swap-mode']"),
  swapPreference: $("#swap-preference"),
  swapSessions: $("#swap-sessions"),
  swapSessionsLabel: $("#swap-sessions-label"),
  swapSingleSession: $("#swap-single-session"),
  swapDestination: $("#swap-destination"),
  swapDestinationLabel: $("#swap-destination-label"),
  swapSubmit: $("#swap-submit"),
  faceForm: $("#face-form"),
  faceText: $("#face-text"),
  blocksForm: $("#blocks-form"),
  blocksText: $("#blocks-text"),
  classForm: $("#class-form"),
  classText: $("#class-text"),
  hthTable: $("#hth-table"),
  ianseoWarning: $("#ianseo-warning"),
  ianseoReady: $("#ianseo-ready"),
  ianseoText: $("#ianseo-text"),
  ianseoCopy: $("#ianseo-copy"),
  ianseoCopyStatus: $("#ianseo-copy-status"),
  ianseoDownload: $("#ianseo-download"),
  ianseoPreview: $("#ianseo-preview"),
};

// Mirrors the Streamlit session state.
const state = {
  roster: [], // REQUIRED records ("archers")
  draw: null, // allocation rows, or null before a draw exists
  hth: [],
  summary: [],
  lastTargets: [],
  lastDetails: [],
  solverStatus: "",
  editMember: null,
  settingsChanged: false,
  faceOverrides: {}, // membership number -> "3s" | "40"
  // Competition setup inputs.
  targetCounts: [17, 17],
  details: ["Double", "Double"],
  capacityEdited: false,
  importMode: "roster",
  busy: false,
};

const timeLimit = Number(eventConfig.solver_time_limit_seconds ?? 60);

const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const cellText = (value) => (typeof value === "boolean" ? (value ? "True" : "False") : String(value ?? ""));

function dataTable(columns, rows, numeric = new Set()) {
  const head = columns.map((column) => `<th>${escapeHTML(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) =>
    `<td${numeric.has(column) ? ' class="numeric"' : ""}>${escapeHTML(cellText(row[column]))}</td>`).join("")}</tr>`).join("");
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const options = (items) => items.map(({ value, label }) =>
  `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join("");

function setNotice(message, kind = "error") {
  elements.notice.textContent = message;
  elements.notice.className = `notice${kind === "error" ? "" : ` ${kind}`}`;
  elements.notice.hidden = false;
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === "dark";
  elements.theme.textContent = isDark ? "☼" : "◐";
  elements.theme.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
  elements.theme.title = `Switch to ${isDark ? "light" : "dark"} theme`;
  elements.theme.setAttribute("aria-pressed", String(isDark));
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#14111b" : "#f6f3f8";
}

const currentMode = () => [...elements.mode].find((input) => input.checked)?.value ?? "Campanile";
const sessionCount = () => Number(elements.sessionCount.value);
const checkedValue = (inputs) => [...inputs].find((input) => input.checked)?.value;

// Normalised roster ("df"), or an empty list when it cannot be normalised.
function normalized() {
  try {
    return state.roster.length ? normalizeRoster(state.roster) : [];
  } catch {
    return [];
  }
}

function capacityTotal() {
  return state.targetCounts.reduce(
    (sum, targets, index) => sum + targets * (state.details[index] === "Double" ? 4 : 2), 0);
}

// Browser convenience: grow the untouched default setup to fit the roster.
function fitDefaultCapacity() {
  if (state.capacityEdited || !state.roster.length) return;
  const fitted = fitTargetCapacity(state.targetCounts, state.details, state.roster.length);
  const changed = fitted.some((count, index) => count !== state.targetCounts[index]);
  if (changed) state.targetCounts = fitted;
  if (capacityTotal() < state.roster.length) state.capacityEdited = true;
  if (changed) renderSessionConfigs();
}

function setImportMode(mode) {
  state.importMode = mode;
  const copying = mode === "copy";
  elements.uploadTitle.textContent = copying ? "Choose schedule file" : "Choose roster file";
  elements.uploadSubtitle.textContent = copying
    ? "CSV, TSV, XLSX or ODS schedule with allocations"
    : "CSV, TSV, XLSX or ODS";
  elements.template.hidden = copying;
}

function renderSessionConfigs() {
  const count = sessionCount();
  while (state.targetCounts.length < count) state.targetCounts.push(17);
  while (state.details.length < count) state.details.push("Double");
  state.targetCounts.length = count;
  state.details.length = count;

  elements.sessionConfigs.innerHTML = Array.from({ length: count }, (_, index) => `
    <div class="session-config" data-session="${index}">
      <div class="session-config-title">Session ${index + 1}</div>
      <label>Targets
        <input class="target-count" type="number" min="1" max="200" value="${state.targetCounts[index]}" aria-label="Targets in session ${index + 1}" data-action />
      </label>
      <label>Detail
        <select class="target-detail" aria-label="Session ${index + 1} detail" title="Double = four archers per target; Single = two archers per target." data-action>
          <option value="Double" ${state.details[index] === "Double" ? "selected" : ""}>Double · 4 archer</option>
          <option value="Single" ${state.details[index] === "Single" ? "selected" : ""}>Single · 2 archer</option>
        </select>
      </label>
    </div>
  `).join("");
  elements.sessionConfigs.querySelectorAll(".target-count").forEach((input, index) => {
    input.addEventListener("input", () => {
      state.capacityEdited = true;
      state.targetCounts[index] = Math.max(1, Math.min(200, Number(input.value) || 1));
      settingsChanged();
    });
  });
  elements.sessionConfigs.querySelectorAll(".target-detail").forEach((select, index) => {
    select.addEventListener("change", () => {
      state.capacityEdited = true;
      state.details[index] = select.value;
      settingsChanged();
    });
  });
  renderCapacity();
  renderSwapAvailability();
}

function renderCapacity() {
  const total = capacityTotal();
  const needed = state.roster.length;
  const effectiveFaces = normalized().map((archer) => ({
    ...archer, _face: state.faceOverrides[archer["Membership Number"]] ?? archer._face,
  }));
  const parity = needed
    ? fullCapacityParityProblem(effectiveFaces, state.targetCounts, state.details, elements.vegas.checked)
    : null;
  const short = needed > 0 && total < needed;
  const tooMany = needed && !short ? tooManyTargetsProblem(needed, state.targetCounts) : null;
  const problem = short ? "short" : tooMany ?? parity;
  elements.totalCapacity.classList.toggle("capacity-short", Boolean(problem));
  elements.totalCapacity.textContent = short ? `${total} / ${needed} places` : `${total} places`;
  if (state.busy) return;
  if (short) {
    elements.runNote.textContent = `There are not enough places for every archer. Add ${needed - total} places before generating.`;
  } else if (tooMany || parity) {
    elements.runNote.textContent = tooMany ?? parity;
  } else if (needed && state.draw && state.settingsChanged) {
    elements.runNote.textContent = "Settings changed. Click Generate schedule to rebuild from the current draw, "
      + "keeping existing allocations where valid.";
  } else if (needed) {
    elements.runNote.textContent = `${needed} archers ready · changes remain in this browser tab.`;
  } else {
    elements.runNote.textContent = state.importMode === "copy"
      ? "Choose a schedule file to copy its allocations."
      : "Import a roster to get started.";
  }
  elements.generate.disabled = !needed || Boolean(problem);
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.querySelectorAll("[data-action]").forEach((element) => { element.disabled = busy; });
  elements.generate.disabled = busy;
  elements.clearAll.disabled = busy || !state.roster.length;
  elements.generate.querySelector(".generate-label").textContent = busy ? "Solving target assignments…" : "Generate schedule";
  if (busy) {
    elements.runNote.textContent = message;
  } else {
    renderCapacity();
    if (state.draw) {
      renderDuplicateTool();
      renderSwapAvailability();
    }
  }
}

// Runs one solver operation in a fresh worker; `solves` scales the timeout.
function runSolver(op, payload, solves = 1) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./solver.worker.js", import.meta.url), { type: "module" });
    let timer = 0;
    const finish = (callback) => (value) => {
      window.clearTimeout(timer);
      worker.terminate();
      callback(value);
    };
    const fail = finish(reject);
    timer = window.setTimeout(
      () => fail(new Error("The solve took too long. Try reducing targets, sessions, or roster size.")),
      (timeLimit * solves + 30) * 1000,
    );
    worker.onmessage = finish(({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data)));
    worker.onerror = (error) => fail(new Error([
      "Browser solver worker error", error.message,
      error.filename && `${error.filename}:${error.lineno ?? 0}:${error.colno ?? 0}`,
    ].filter(Boolean).join(" · ")));
    worker.onmessageerror = () => fail(new Error("The browser could not read the solver's response. Reload the page and try again."));
    worker.postMessage({ op, payload });
  });
}

// Solver inputs for every regeneration. Like the Streamlit edits, they use
// the current grouping and Vegas settings.
const solvePayload = (archers, targets, details, extra = {}, overrides = state.faceOverrides) => ({
  archers,
  targets,
  details,
  config: eventConfig,
  mode: currentMode(),
  vegasMode: elements.vegas.checked,
  existingDraw: state.draw ?? [],
  faceOverrides: indexedOverrides(archers, overrides),
  ...extra,
});

// Runs one user action. Failures are reported with the Streamlit message
// prefix and leave the state untouched.
async function perform(prefix, action, busyMessage = "") {
  if (state.busy) return;
  clearNotice();
  if (busyMessage) setBusy(true, busyMessage);
  try {
    await action();
  } catch (error) {
    setNotice(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (busyMessage) setBusy(false);
  }
}

const regenerating = `Regenerating the schedule; this may take up to ${timeLimit} seconds.`;

function commit({ roster, draw, status, notice, noticeKind = "success", faceOverrides }) {
  if (roster) {
    state.faceOverrides = reconcileOverrides(state.roster, roster, state.faceOverrides);
    state.roster = roster;
    const archers = normalized();
    state.hth = archers.length ? headToHeads(archers) : [];
  }
  if (draw) {
    state.draw = draw;
    state.summary = refreshSummary(draw);
  }
  if (status) state.solverStatus = status;
  if (faceOverrides) state.faceOverrides = faceOverrides;
  render();
  if (notice) setNotice(notice, noticeKind);
}

// ---- Import ----

function handleFile(file) {
  if (!file) return;
  perform("Import failed", async () => {
    try {
      const table = await readEntryFile(file);
      const incoming = prepareImportRoster(table);
      validateImportedRoster(incoming);
      if (state.importMode === "copy") {
        const draw = restoreImportedDraw(table, incoming);
        const capacity = importedCapacity(draw);
        state.lastTargets = capacity.targets;
        state.lastDetails = capacity.details;
        // Show the copied layout in the setup panel, so a later Generate or
        // settings change builds on it.
        showCapacity(capacity.targets, capacity.details);
        state.settingsChanged = false;
        state.editMember = null;
        const roster = incoming.map(rosterRecord);
        commit({
          roster,
          draw,
          faceOverrides: overridesFromDraw(draw, roster),
          status: "Imported",
          notice: `Copied ${draw.length} existing allocations. No new schedule was generated.`,
        });
      } else {
        const merged = mergeRoster(state.roster, incoming);
        const keepDraw = Boolean(state.draw?.length);
        if (!keepDraw) Object.assign(state, { draw: null, summary: [], lastTargets: [], lastDetails: [] });
        commit({
          roster: merged,
          notice: `Imported ${incoming.length} rows; ${merged.length} archers are now in the roster. `
            + (keepDraw
              ? "Existing assignments will be preserved where valid when you generate the updated schedule."
              : "Configure the sessions and click Generate schedule."),
        });
        fitDefaultCapacity();
      }
    } finally {
      elements.file.value = "";
    }
  });
}

function downloadBlob(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadTemplate() {
  const sample = [
    REQUIRED,
    ["Alex", "Archer", "recurve", "QUB", "open", "advanced", "10001", "both days", ""],
    ["Sam", "Shooter", "barebow", "UCD", "female", "beginner", "10002", "saturday only", "1"],
  ];
  downloadBlob("archer_roster_template.csv", Papa.unparse(sample), "text/csv;charset=utf-8");
}

function clearAll() {
  if (state.busy) return;
  Object.assign(state, {
    roster: [], draw: null, hth: [], summary: [], editMember: null, capacityEdited: false, faceOverrides: {}, settingsChanged: false,
  });
  elements.file.value = "";
  elements.importMode.forEach((input) => { input.checked = input.value === "roster"; });
  setImportMode("roster");
  render();
  clearNotice();
}

// ---- Generate ----

function generate() {
  const archers = normalized();
  if (!archers.length) return;
  const targets = [...state.targetCounts];
  const details = [...state.details];
  perform("Scheduling halted", async () => {
    const solved = await runSolver("solve", solvePayload(archers, targets, details));
    state.lastTargets = targets;
    state.lastDetails = details;
    state.settingsChanged = false;
    commit({ roster: state.roster, draw: solved.draw, status: solved.status, notice: `Schedule generated: ${solved.status}` });
  }, `Solving in a background worker; this may take up to ${timeLimit} seconds.`);
}

// Sets the setup panel to a session layout.
function showCapacity(targets, details) {
  const count = targets.length;
  if (!elements.sessionCount.querySelector(`option[value="${count}"]`)) {
    elements.sessionCount.insertAdjacentHTML("beforeend", `<option value="${count}">${count} sessions</option>`);
  }
  elements.sessionCount.value = String(count);
  state.targetCounts = [...targets];
  state.details = [...details];
  state.capacityEdited = true;
  renderSessionConfigs();
}

// Generate stays manual: a setup change with a draw on screen only marks
// the draw as out of date, so several changes cost one solve.
function settingsChanged() {
  if (state.draw) state.settingsChanged = true;
  renderCapacity();
}

// Re-solves an updated roster with the last generated capacity, dropping
// the overrides that the roster change invalidates.
const resolveWith = (roster, extra = {}, overrides = reconcileOverrides(state.roster, roster, state.faceOverrides)) =>
  runSolver("solve", solvePayload(normalizeRoster(roster), state.lastTargets, state.lastDetails, extra, overrides));

// ---- Rendering ----

// The roster table starts open, and collapses once a draw is shown.
let rosterShownWithDraw = null;
function renderRoster() {
  const hasDraw = Boolean(state.draw);
  if (rosterShownWithDraw !== hasDraw) {
    elements.rosterSection.querySelector("details").open = !hasDraw;
    rosterShownWithDraw = hasDraw;
  }
  elements.rosterSection.hidden = !state.roster.length;
  if (!state.roster.length) return;
  const archers = normalized();
  elements.rosterSummaryTitle.textContent = `${state.roster.length} archers loaded.`;
  const rows = archers.map((archer) => {
    const override = state.faceOverrides[archer["Membership Number"]];
    return {
      ...archer,
      "Target Face": override ? `${override} (override)` : archer._face,
      "Head-to-Head Category": archer._code,
    };
  });
  elements.rosterTable.innerHTML = dataTable([...REQUIRED, "Target Face", "Head-to-Head Category"], rows);
}

function renderRosterStatus() {
  const count = state.roster.length;
  elements.rosterStatus.classList.toggle("is-loaded", count > 0);
  elements.clearAll.disabled = count === 0 || state.busy;
  elements.rosterStatus.innerHTML = count
    ? `<span class="status-dot"></span><span>${count} archer${count === 1 ? "" : "s"} loaded</span>`
    : '<span class="status-dot"></span><span>No roster loaded</span>';
  elements.rosterPreview.hidden = count === 0;
  if (count) {
    const names = state.roster.slice(0, 3).map((archer) => escapeHTML(`${archer["First Name"]} ${archer["Last Name"]}`));
    const remaining = Math.max(0, count - names.length);
    elements.rosterPreview.innerHTML = `${names.join("<br>")}${remaining ? `<br>+ ${remaining} more` : ""}`;
  }
}

function renderClassCounts() {
  const rows = classCountRows(state.roster);
  if (!rows.length) {
    elements.classCounts.innerHTML = "";
    return;
  }
  const width = Math.max(...rows.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, index) => `<th>Class ${index + 1}</th><th>Archers ${index + 1}</th>`).join("");
  const body = rows.map((row) => `<tr>${Array.from({ length: width }, (_, index) => {
    const item = row[index];
    return `<td>${item ? escapeHTML(item[0]) : ""}</td><td>${item ? item[1] : ""}</td>`;
  }).join("")}</tr>`).join("");
  elements.classCounts.innerHTML = `<table class="class-table"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
}

const titleCase = (value) => String(value).replace(/\b\w/g, (letter) => letter.toUpperCase());

function renderShootingList() {
  const draw = state.draw;
  const conflicts = incompatibleFaces(draw);
  const sessions = [...new Set(draw.map((row) => row.Session))].sort((left, right) => left - right);
  elements.sessions.innerHTML = sessions.map((session) => {
    const sessionRows = draw.filter((row) => row.Session === session);
    const targets = [...new Set(sessionRows.map((row) => row.Target))].sort((left, right) => left - right);
    const detail = state.lastDetails[session - 1] ?? "";
    return `<section class="session-output">
      <div class="session-output-title"><h4>Session ${session}</h4><span>${sessionRows.length} ARCHERS${detail ? ` · ${detail.toUpperCase()}` : ""}</span></div>
      <div class="target-grid">${targets.map((target, targetIndex) => {
        const members = sessionRows.filter((row) => row.Target === target);
        const conflict = conflicts.has(`${session}|${target}`);
        const faces = [...new Set(members.map((row) => row["Target Face"]))].sort().join(" / ");
        return `<article class="target-block${conflict ? " has-conflict" : ""}" style="animation-delay:${Math.min(targetIndex * 18, 300)}ms">
          <header class="target-block-head"><strong>TARGET ${target}</strong><span>${escapeHTML(faces)}</span></header>
          ${conflict ? `<div class="face-warning">Target ${target} has incompatible face types. Review the A/C and B/D face pairs.</div>` : ""}
          <div class="archer-slot-list">${members.map((row) => `<div class="archer-slot">
            <span class="position-label">${escapeHTML(row.Position)}</span>
            <div class="archer-details">
              <div class="archer-name" title="${escapeHTML(row.Archer)}">${escapeHTML(row.Archer)}</div>
              <div class="archer-college">${escapeHTML(row["Category Code"] || titleCase(row.Gender))} · ${escapeHTML(row.College)} · ${escapeHTML(row["Bow Type"])}</div>
              <div class="archer-meta">Membership: ${escapeHTML(row["Membership Number"])} · Face: ${escapeHTML(row["Target Face"])}</div>
            </div>
            <div class="slot-end">
              <span class="class-chip">${escapeHTML(row["Category Code"])}</span>
              <button class="edit-button" type="button" data-action data-edit="${escapeHTML(row["Membership Number"])}" title="Edit archer" aria-label="Edit ${escapeHTML(row.Archer)}">✎</button>
            </div>
          </div>`).join("")}</div>
        </article>`;
      }).join("")}</div>
    </section>`;
  }).join("");
}

const drawMembers = () => [...new Set(state.draw.map((row) => String(row["Membership Number"])))];

function renderEditArcher() {
  const member = state.editMember;
  const archer = member !== null && state.draw && drawMembers().includes(member)
    ? state.roster.find((row) => String(row["Membership Number"]) === member)
    : null;
  elements.editForm.hidden = !archer;
  if (!archer) return;
  elements.editTitle.textContent = `Edit archer: ${member}`;
  elements.editFields.innerHTML = REQUIRED.map((field, index) => `<label class="field-label">${escapeHTML(field)}
    <input class="field-control" data-field-index="${index}" value="${escapeHTML(archer[field])}" /></label>`).join("");
}

function renderDuplicateTool() {
  const sessions = [...new Set(state.draw.map((row) => row.Session))].sort((left, right) => left - right);
  const source = state.draw[Number(elements.duplicateSource.value)];
  const destinations = source ? sessions.filter((session) => session !== source.Session) : [];
  const previous = elements.duplicateDestination.value;
  elements.duplicateDestination.innerHTML = options(destinations.map((session) => ({ value: session, label: String(session) })));
  if (destinations.map(String).includes(previous)) elements.duplicateDestination.value = previous;
  elements.duplicateNote.hidden = destinations.length > 0;
  elements.duplicateDestination.closest("label").hidden = destinations.length === 0;
  elements.duplicateSubmit.disabled = state.busy || destinations.length === 0;
}

function renderDeleteTool() {
  const byArcher = checkedValue(elements.deleteMode) === "archer";
  elements.deleteAllocationLabel.hidden = byArcher;
  elements.deleteArcherLabel.hidden = !byArcher;
  elements.deleteSubmit.textContent = byArcher ? "Delete archer and all allocations" : "Delete allocation";
}

function renderSwapAvailability() {
  if (!state.draw) return;
  const byArcher = checkedValue(elements.swapMode) === "archer";
  const single = sessionCount() <= 1;
  elements.swapPreference.hidden = byArcher;
  elements.swapDestinationLabel.hidden = !byArcher;
  elements.swapSessionsLabel.hidden = single;
  elements.swapSingleSession.hidden = !single;
  elements.swapSubmit.hidden = !byArcher && single;
  elements.swapSubmit.textContent = byArcher ? "Apply swap" : "Apply session preference";
  elements.swapSubmit.disabled = state.busy;
  if (byArcher) {
    const destinations = swapDestinations(state.draw, elements.swapMember.value, state.lastTargets, state.lastDetails);
    elements.swapDestination.innerHTML = options(destinations.map((destination) => ({
      value: `${destination.session}|${destination.target}|${destination.position}`, label: destination.label,
    })));
    elements.swapSubmit.disabled = state.busy || !destinations.length;
  }
}

function renderModifyTools() {
  const draw = state.draw;
  const labels = new Map(draw.map((row) => [String(row["Membership Number"]), archerAllocationLabel(row)]));
  const members = drawMembers();
  const memberOptions = members.map((member) => ({ value: member, label: labels.get(member) ?? member }));

  const source = elements.duplicateSource.value;
  elements.duplicateSource.innerHTML = options(draw.map((row, index) => ({ value: index, label: archerAllocationLabel(row) })));
  if (source && Number(source) < draw.length) elements.duplicateSource.value = source;
  renderDuplicateTool();

  elements.deleteAllocation.innerHTML = options(draw.map((row) => ({
    value: JSON.stringify([String(row["Membership Number"]), row.Session, row.Target, String(row.Position)]),
    label: archerAllocationLabel(row),
  })));
  elements.deleteArcher.innerHTML = options(memberOptions);
  renderDeleteTool();

  const swapMember = elements.swapMember.value;
  elements.swapMember.innerHTML = options(memberOptions);
  if (members.includes(swapMember)) elements.swapMember.value = swapMember;
  renderSwapAvailability();
  renderEditArcher();
}

function renderIanseo() {
  try {
    const rows = ianseoImportRows(state.roster, eventConfig, state.draw);
    elements.ianseoText.value = ianseoText(rows);
    elements.ianseoPreview.innerHTML = dataTable(IANSEO_COLUMNS, rows);
    elements.ianseoWarning.hidden = true;
    elements.ianseoReady.hidden = false;
  } catch (error) {
    elements.ianseoWarning.textContent = `IANSEO export is not ready: ${error.message}`;
    elements.ianseoWarning.hidden = false;
    elements.ianseoReady.hidden = true;
  }
}

function render() {
  renderRosterStatus();
  renderRoster();
  renderCapacity();
  const hasDraw = Boolean(state.draw);
  elements.emptyCanvas.hidden = hasDraw || state.roster.length > 0;
  elements.scheduleContent.hidden = !hasDraw;
  elements.resultActions.hidden = !hasDraw;
  if (!hasDraw) {
    elements.resultsTitle.textContent = "Your target list";
    elements.resultsSubtitle.textContent = state.roster.length
      ? "Configure the sessions and click Generate schedule."
      : "A valid draw will appear here after generation.";
    return;
  }

  const draw = state.draw;
  elements.resultsTitle.textContent = state.solverStatus === "Imported" ? "Copied schedule" : "Schedule generated";
  elements.resultsSubtitle.textContent = `${currentMode()}${elements.vegas.checked ? " · Vegas faces enabled" : ""}`;
  elements.status.textContent = state.solverStatus;
  elements.drawCount.textContent = `${draw.length} ALLOCATIONS`;
  const places = state.lastTargets.reduce((sum, count, index) => sum + count * (state.lastDetails[index] === "Single" ? 2 : 4), 0);
  elements.metrics.innerHTML = [
    ["ARCHERS", draw.length],
    ["TARGETS USED", new Set(draw.map((row) => `${row.Session}.${row.Target}`)).size],
    ["OPEN PLACES", Math.max(0, places - draw.length)],
    ["VEGAS", draw.filter((row) => row["Target Face"] === "Vegas").length],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  elements.sessionSummary.innerHTML = dataTable(SUMMARY_COLUMNS, state.summary, new Set(SUMMARY_COLUMNS));
  renderClassCounts();
  renderShootingList();
  renderModifyTools();
  elements.hthTable.innerHTML = dataTable(HTH_COLUMNS, state.hth,
    new Set(["Entrants", "Elimination Rounds", "Bracket Matches", "Total Matches Including Bronze"]));
  renderIanseo();
  if (state.busy) document.querySelectorAll("[data-action]").forEach((element) => { element.disabled = true; });
}

// ---- Modify the draw ----

function saveArcherEdit(event) {
  event.preventDefault();
  const member = state.editMember;
  const edited = Object.fromEntries([...elements.editFields.querySelectorAll("input")]
    .map((input) => [REQUIRED[Number(input.dataset.fieldIndex)], input.value]));
  perform("Could not save archer details", async () => {
    const roster = editArcher(state.roster, member, edited);
    // Follow a membership number change; a face-field change drops it.
    const before = state.roster.find((archer) => String(archer["Membership Number"]) === member);
    const after = roster[state.roster.indexOf(before)];
    const overrides = { ...state.faceOverrides };
    if (overrides[member] && after["Membership Number"] !== member) {
      overrides[after["Membership Number"]] = overrides[member];
      delete overrides[member];
    }
    const faceOverrides = reconcileOverrides(
      state.roster.map((archer) => (archer === before ? { ...before, "Membership Number": after["Membership Number"] } : archer)),
      roster,
      overrides,
    );
    const solved = await resolveWith(roster, {}, faceOverrides);
    state.editMember = null;
    commit({
      roster, draw: solved.draw, status: solved.status, faceOverrides,
      notice: "Archer details saved and schedule regenerated.",
    });
  }, regenerating);
}

function duplicate(event) {
  event.preventDefault();
  perform("Could not duplicate archer", async () => {
    const result = duplicateArcher({
      draw: state.draw,
      roster: state.roster,
      sourceIndex: Number(elements.duplicateSource.value),
      destination: Number(elements.duplicateDestination.value),
      lastTargets: state.lastTargets,
      lastDetails: state.lastDetails,
      vegasMode: elements.vegas.checked,
    });
    // The copy keeps the source's face through later regenerations.
    const faceOverrides = setOverride(state.faceOverrides, result.roster, result.duplicate.member, result.duplicate.face);
    commit({ ...result, faceOverrides });
  });
}

function remove(event) {
  event.preventDefault();
  perform("Could not delete", async () => {
    if (checkedValue(elements.deleteMode) === "archer") {
      if (!elements.deleteArcher.value) throw new Error("There are no allocated archers to delete.");
      commit(deleteArcher(state.draw, state.roster, elements.deleteArcher.value));
    } else {
      if (!elements.deleteAllocation.value) throw new Error("There are no allocations to delete.");
      const [member, session, target, position] = JSON.parse(elements.deleteAllocation.value);
      commit(deleteAllocation(state.draw, state.roster, { member, session, target, position }));
    }
  });
}

function batch(event) {
  event.preventDefault();
  perform("Could not apply batch session changes", async () => {
    const { roster, forcedSessions, count } = batchSessionChanges(
      elements.batchText.value, state.draw, state.roster, state.lastTargets);
    const solved = await resolveWith(roster, { forcedSessions });
    commit({ roster, draw: solved.draw, status: solved.status, notice: `Applied ${count} batch session change(s).` });
  }, regenerating);
}

function swap(event) {
  event.preventDefault();
  const member = elements.swapMember.value;
  if (checkedValue(elements.swapMode) === "archer") {
    perform("Could not apply swap", async () => {
      const [session, target, position] = elements.swapDestination.value.split("|");
      commit(swapWithDestination(state.draw, member, { session: Number(session), target: Number(target), position }));
    });
  } else {
    perform("Could not apply session preference", async () => {
      const roster = applySessionPreference(state.roster, member, elements.swapSessions.value, sessionCount());
      const solved = await resolveWith(roster);
      commit({ roster, draw: solved.draw, status: solved.status });
    }, regenerating);
  }
}

function faceSwaps(event) {
  event.preventDefault();
  perform("Could not apply target-face swaps", async () => {
    const allocations = elements.faceText.value.split(",").map((part) => part.trim()).filter(Boolean);
    if (!allocations.length) throw new Error("Enter at least one allocation.");
    allocations.forEach(parseAllocation);
    const solved = await runSolver("faceSwap", {
      ...solvePayload(normalizeRoster(state.roster), state.lastTargets, state.lastDetails),
      draw: state.draw,
      allocations,
    }, 3);
    const { failures } = solved;
    let faceOverrides = state.faceOverrides;
    for (const [member, face] of Object.entries(solved.applied)) {
      faceOverrides = setOverride(faceOverrides, state.roster, member, face);
    }
    commit({
      draw: solved.draw,
      status: solved.status,
      faceOverrides,
      notice: failures.length
        ? `Some face swaps could not be completed: ${failures.join("; ")}`
        : "All requested target-face swaps were applied.",
      noticeKind: failures.length ? "warning" : "success",
    });
  }, `Trying the requested face changes; this may take up to ${timeLimit * 3} seconds.`);
}

function swapBlocks(event) {
  event.preventDefault();
  perform("Could not swap target blocks", async () => {
    const draw = swapTargetBlockNumbers(state.draw, elements.blocksText.value);
    commit({ draw, notice: `Swapped target blocks ${elements.blocksText.value.trim()}.` });
  });
}

function swapClasses(event) {
  event.preventDefault();
  perform("Could not apply class swaps", async () => {
    const { roster, count } = classSwaps(elements.classText.value, state.draw, state.roster);
    const solved = await resolveWith(roster);
    commit({
      roster,
      draw: solved.draw,
      status: solved.status,
      notice: `Updated ${count} archer class(es), recalculated their face types, and regenerated the schedule.`,
    });
  }, regenerating);
}

async function copyIanseo() {
  const text = elements.ianseoText.value;
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    elements.ianseoText.focus();
    elements.ianseoText.select();
    if (!document.execCommand("copy")) {
      elements.ianseoCopyStatus.textContent = "Copy failed; select the text and copy it manually.";
      return;
    }
  }
  elements.ianseoCopy.textContent = "Copied";
  elements.ianseoCopyStatus.textContent = "Copied to clipboard.";
  window.setTimeout(() => {
    elements.ianseoCopy.textContent = "Copy all";
    elements.ianseoCopyStatus.textContent = "";
  }, 2000);
}

// ---- Wiring ----

elements.file.addEventListener("change", (event) => handleFile(event.target.files?.[0]));
elements.template.addEventListener("click", downloadTemplate);
elements.clearAll.addEventListener("click", clearAll);
elements.sessionCount.addEventListener("change", () => {
  state.capacityEdited = true;
  renderSessionConfigs();
  settingsChanged();
});
elements.vegas.addEventListener("change", settingsChanged);
elements.mode.forEach((input) => input.addEventListener("change", settingsChanged));
elements.generate.addEventListener("click", generate);
elements.download.addEventListener("click", () => {
  if (state.draw) downloadBlob("shooting_list.csv", shootingListCsv(state.draw), "text/csv;charset=utf-8");
});
elements.downloadWorkbook.addEventListener("click", () => {
  if (!state.draw) return;
  perform("Could not build the Excel workbook", async () => {
    downloadBlob("archery_schedule.xlsx", await workbookBytes(state.draw, state.hth, state.summary),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
elements.importMode.forEach((input) => input.addEventListener("change", () => {
  setImportMode(input.value);
  renderCapacity();
}));
elements.theme.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
elements.uploadZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.uploadZone.classList.add("is-dragging");
});
elements.uploadZone.addEventListener("dragleave", () => elements.uploadZone.classList.remove("is-dragging"));
elements.uploadZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.uploadZone.classList.remove("is-dragging");
  handleFile(event.dataTransfer.files?.[0]);
});

elements.sessions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit]");
  if (!button || state.busy) return;
  state.editMember = button.dataset.edit;
  renderEditArcher();
  elements.editForm.scrollIntoView({ behavior: "smooth", block: "start" });
});
elements.editForm.addEventListener("submit", saveArcherEdit);
elements.cancelEdit.addEventListener("click", () => {
  state.editMember = null;
  renderEditArcher();
});
elements.duplicateSource.addEventListener("change", renderDuplicateTool);
elements.duplicateForm.addEventListener("submit", duplicate);
elements.deleteMode.forEach((input) => input.addEventListener("change", renderDeleteTool));
elements.deleteForm.addEventListener("submit", remove);
elements.batchForm.addEventListener("submit", batch);
elements.swapMember.addEventListener("change", renderSwapAvailability);
elements.swapMode.forEach((input) => input.addEventListener("change", renderSwapAvailability));
elements.swapForm.addEventListener("submit", swap);
elements.faceForm.addEventListener("submit", faceSwaps);
elements.blocksForm.addEventListener("submit", swapBlocks);
elements.classForm.addEventListener("submit", swapClasses);
elements.ianseoCopy.addEventListener("click", copyIanseo);
elements.ianseoDownload.addEventListener("click", () => {
  downloadBlob("ianseo_participants.tsv", `﻿${elements.ianseoText.value}`, "text/tab-separated-values");
});

renderSessionConfigs();
setImportMode("roster");
applyTheme("dark");
render();
