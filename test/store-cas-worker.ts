import { parentPort, workerData } from "node:worker_threads";
import { MazzyStore } from "../src/store.ts";

type Work = { path: string; barrier: SharedArrayBuffer; operation: "update" | "review-evidence"; taskId: string; input: Record<string, unknown> };
const work = workerData as Work;
const gate = new Int32Array(work.barrier);
const port = parentPort!;

Atomics.add(gate, 0, 1);
port.postMessage({ type: "ready" });
Atomics.wait(gate, 1, 0);
const store = new MazzyStore(work.path);
try {
  const value = work.operation === "update"
    ? store.updateTask(work.taskId, work.input as Parameters<MazzyStore["updateTask"]>[1])
    : store.recordReviewerEvidence(work.taskId, work.input as unknown as Parameters<MazzyStore["recordReviewerEvidence"]>[1]);
  port.postMessage({ type: "result", ok: true, value });
} catch (error) {
  port.postMessage({ type: "result", ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  store.close();
}
