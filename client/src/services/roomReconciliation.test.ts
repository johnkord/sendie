import { describe, expect, it } from 'vitest';
import { diffPeerRoster } from './roomReconciliation';

describe('diffPeerRoster', () => {
  it('identifies added, removed, and retained peers', () => {
    expect(diffPeerRoster(
      ['stale-peer', 'retained-peer'],
      ['retained-peer', 'new-peer'],
    )).toEqual({
      added: ['new-peer'],
      removed: ['stale-peer'],
      retained: ['retained-peer'],
    });
  });

  it('deduplicates repeated peer identifiers', () => {
    expect(diffPeerRoster(['peer-a', 'peer-a'], ['peer-a', 'peer-b', 'peer-b']))
      .toEqual({
        added: ['peer-b'],
        removed: [],
        retained: ['peer-a'],
      });
  });
});
