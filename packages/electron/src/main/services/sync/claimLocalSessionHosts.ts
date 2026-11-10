type SyncRow = { id: string; hostDeviceId?: string; metadata?: Record<string, any> };

const persisting = new Set<string>();

export function localSessionHost(row: SyncRow): string | undefined {
  return row.hostDeviceId ?? (typeof row.metadata?.hostDeviceId === 'string' ? row.metadata.hostDeviceId : undefined);
}

/**
 * Attribute this desktop's untagged sessions to it, so another desktop can list
 * and drive them. Sessions created before host attribution, or by paths that do
 * not stamp it, otherwise never appear under this machine. Each claim is also
 * persisted so live publishes carry it too.
 */
export function claimLocalSessionHosts<T extends SyncRow>(
  rows: T[],
  localDeviceId: string | undefined,
  persist: (sessionId: string, hostDeviceId: string) => Promise<void>,
): T[] {
  if (!localDeviceId) return rows;
  const claimed: string[] = [];
  const result = rows.map(row => {
    if (localSessionHost(row)) return row;
    if (!persisting.has(row.id)) {
      persisting.add(row.id);
      claimed.push(row.id);
    }
    return { ...row, hostDeviceId: localDeviceId, metadata: { ...row.metadata, hostDeviceId: localDeviceId } };
  });
  void (async () => {
    for (const id of claimed) {
      try { await persist(id, localDeviceId); } finally { persisting.delete(id); }
    }
  })();
  return result;
}
