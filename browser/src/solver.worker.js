import loadHighs from "highs";
import highsWasmUrl from "highs/runtime?url";
import { solveSchedule, statusName, targetFaceSwaps } from "./solve.js";

const highsPromise = loadHighs({
  locateFile: (file) => file.endsWith(".wasm") ? highsWasmUrl : file,
});

// { op: "solve" | "faceSwap", payload } -> { draw, status, failures? } or { error }
self.onmessage = async ({ data: { op, payload } }) => {
  try {
    const highs = await highsPromise;
    const solved = op === "faceSwap" ? targetFaceSwaps(highs, payload) : solveSchedule(highs, payload);
    self.postMessage({ draw: solved.draw, status: statusName(solved.result), failures: solved.failures ?? [], applied: solved.applied ?? {} });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
