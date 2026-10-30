import type { DraftState, Market, Projection, Player, Risk } from "@/types";

export interface ProjectionProvider {
  getProjections(): Promise<{ player: Player; projection: Projection }[]>;
}
export interface ADPProvider {
  getMarket(): Promise<Market[]>;
}
export interface InjuryProvider {
  getRisk(): Promise<Risk[]>;
}
export interface DraftProvider {
  getDraftState(): Promise<DraftState>;
}
