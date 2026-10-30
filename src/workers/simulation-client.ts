import type { SimulationInput, SimulationResult } from "@/types";
import type { WorkerRequest, WorkerResponse } from "./simulation.worker";

/**
 * Lazily creates the simulation worker. Only the latest run() resolves; any
 * earlier in-flight request REJECTS with Error("superseded") when a newer one starts.
 */
export class SimulationClient {
  private worker: Worker | null = null;
  private latestId = 0;
  private pending = new Map<
    number,
    { resolve: (r: SimulationResult) => void; reject: (e: Error) => void }
  >();

  private ensure(): Worker {
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      throw new Error("SimulationClient is only available in the browser");
    }
    if (!this.worker) {
      const w = new Worker(new URL("./simulation.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        const p = this.pending.get(msg.requestId);
        if (!p) return; // stale / superseded
        this.pending.delete(msg.requestId);
        if ("error" in msg) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      };
      w.onerror = (ev) => this.rejectAll(new Error(ev.message || "simulation worker error"));
      this.worker = w;
    }
    return this.worker;
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  run(input: SimulationInput): Promise<SimulationResult> {
    let worker: Worker;
    try {
      worker = this.ensure();
    } catch (e) {
      return Promise.reject(e);
    }
    const requestId = ++this.latestId;
    for (const [id, p] of this.pending) {
      p.reject(new Error("superseded"));
      this.pending.delete(id);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const req: WorkerRequest = { requestId, input };
      worker.postMessage(req);
    });
  }

  terminate(): void {
    this.rejectAll(new Error("terminated"));
    this.worker?.terminate();
    this.worker = null;
  }
}
