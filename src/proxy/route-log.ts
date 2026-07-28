export interface RouteLogEntry {
  at: string;
  ask?: string;
  tier?: string;
  model?: string;
  plain?: boolean;
  toolsOmitted?: number;
  latencyMs?: number;
  coerced?: boolean;
  plainRetry?: boolean;
  outcome?: string;
}

const MAX = 30;
const buffer: RouteLogEntry[] = [];

export function pushRouteLog(entry: RouteLogEntry): void {
  buffer.push(entry);
  while (buffer.length > MAX) buffer.shift();
}

export function getRouteLog(): RouteLogEntry[] {
  return [...buffer];
}

export function clearRouteLog(): void {
  buffer.length = 0;
}
