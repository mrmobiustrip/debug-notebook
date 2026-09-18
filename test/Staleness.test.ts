import { describe, expect, it } from 'vitest';
import { RUN_METADATA_KEY, describeRun, readRunMetadata } from '../src/notebook/Staleness';

const meta = { sessionRunId: 's', sessionName: 'Python', stopSeq: 3, location: 'foo.py:42 in bar()' };

describe('staleness', () => {
  it('current when stopSeq matches', () => {
    const s = describeRun(meta, { stopSeq: 3, terminated: false });
    expect(s.kind).toBe('current');
    expect(s.text).toBe('● foo.py:42 in bar()');
  });

  it('stale with stop count', () => {
    const s = describeRun(meta, { stopSeq: 6, terminated: false });
    expect(s.kind).toBe('stale');
    expect(s.text).toBe('○ stale — ran at foo.py:42 in bar(), 3 stops ago');
    expect(describeRun(meta, { stopSeq: 4, terminated: false }).text).toContain('1 stop ago');
  });

  it('gone when the session is missing or terminated', () => {
    expect(describeRun(meta, undefined).kind).toBe('gone');
    expect(describeRun(meta, { stopSeq: 3, terminated: true }).kind).toBe('gone');
  });

  it('readRunMetadata validates shape', () => {
    expect(readRunMetadata(undefined)).toBeUndefined();
    expect(readRunMetadata({ [RUN_METADATA_KEY]: { sessionRunId: 's' } })).toBeUndefined();
    expect(readRunMetadata({ [RUN_METADATA_KEY]: meta })).toEqual(meta);
  });
});
