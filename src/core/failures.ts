export interface FailureTracker {
  signature: string | null;
  count: number;
}

export const EMPTY_TRACKER: FailureTracker = { signature: null, count: 0 };

export function failureSignature(tool: string, errorText: string): string {
  return `${tool}:${errorText.trim().slice(0, 120)}`;
}

export function recordFailure(tracker: FailureTracker, signature: string): FailureTracker {
  return tracker.signature === signature ? { signature, count: tracker.count + 1 } : { signature, count: 1 };
}

export function recordSuccess(tracker: FailureTracker, tool: string): FailureTracker {
  return tracker.signature?.startsWith(`${tool}:`) ? EMPTY_TRACKER : tracker;
}
