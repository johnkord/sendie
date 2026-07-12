export interface PeerRosterDiff {
  added: string[];
  removed: string[];
  retained: string[];
}

export function diffPeerRoster(
  currentPeerIds: Iterable<string>,
  expectedPeerIds: Iterable<string>,
): PeerRosterDiff {
  const current = new Set(currentPeerIds);
  const expected = new Set(expectedPeerIds);

  return {
    added: Array.from(expected).filter((peerId) => !current.has(peerId)),
    removed: Array.from(current).filter((peerId) => !expected.has(peerId)),
    retained: Array.from(expected).filter((peerId) => current.has(peerId)),
  };
}
