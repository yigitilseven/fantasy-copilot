import type { SimulationInput, SimulationResult } from "@/types";
import { simulateSurvival } from "@/engine/draft/simulator";

export interface WorkerRequest {
  requestId: number;
  input: SimulationInput;
}
export type WorkerResponse =
  | { requestId: number; result: SimulationResult }
  | { requestId: number; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse): void;
};

ctx.onmessage = (e) => {
  const { requestId, input } = e.data;
  try {
    ctx.postMessage({ requestId, result: simulateSurvival(input) });
  } catch (err) {
    ctx.postMessage({ requestId, error: err instanceof Error ? err.message : String(err) });
  }
};
