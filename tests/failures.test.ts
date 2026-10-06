import { describe, expect, it } from 'vitest';
import { EMPTY_TRACKER, failureSignature, recordFailure, recordSuccess } from '../src/core/failures.js';

describe('failure tracker', () => {
  it('counts the same failure in a row and restarts on a different one', () => {
    const sig = failureSignature('Bash', 'npm test\nFAIL a.test.ts');
    let t = recordFailure(EMPTY_TRACKER, sig);
    t = recordFailure(t, sig);
    expect(t.count).toBe(2);
    t = recordFailure(t, failureSignature('Bash', 'other error'));
    expect(t.count).toBe(1);
  });

  it('resets on a success of the same tool only', () => {
    const t = recordFailure(EMPTY_TRACKER, failureSignature('Bash', 'boom'));
    expect(recordSuccess(t, 'Read')).toBe(t);
    expect(recordSuccess(t, 'Bash')).toEqual(EMPTY_TRACKER);
  });
});
