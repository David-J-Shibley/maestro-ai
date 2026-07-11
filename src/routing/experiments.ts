/** Placeholder for A/B routing experiments — not yet implemented. */
export interface AbExperiment {
  name: string;
  variantA: string;
  variantB: string;
  trafficPercent: number;
}

export function selectAbVariant(_experiment: AbExperiment): "A" | "B" {
  return "A";
}
