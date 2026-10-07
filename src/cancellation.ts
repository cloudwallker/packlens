/** Cancellation is control flow, never a completed/unknown scenario to commit. */
export class AnalysisCancelledError extends Error {
  readonly code = 'CANCELLED';
  cleanupId?: string;
  constructor() { super('CANCELLED'); this.name = 'AbortError'; }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisCancelledError();
}
