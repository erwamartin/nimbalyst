// @vitest-environment node
import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionLaunchCountAtom } from '../sessionLaunchCounts';
import { refreshSessionListAtom, sessionListWorkspaceAtom, sessionProcessingAtom, sessionRegistryAtom, sessionUnreadAtom } from '../sessions';

afterEach(() => vi.unstubAllGlobals());

describe('session launch count hydration', () => {
  it('retains archived/hidden launch counts through partial child hydration and clears deleted launches on refresh', async () => {
    const store = createStore();
    const invoke = vi.fn().mockResolvedValue({
      success: true, sessions: [{ id: 'coordinator', createdAt: 1, updatedAt: 1 }],
      launchedSessionCounts: { coordinator: 3 },
    });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionListWorkspaceAtom, '/project');
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(3);
    expect(store.get(sessionLaunchCountAtom('ordinary'))).toBe(0);
    // Child list hydration / view filtering cannot replace the launch projection.
    store.set(sessionRegistryAtom, new Map());
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(3);

    invoke.mockResolvedValueOnce({ success: false, sessions: [] });
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(3);
    invoke.mockResolvedValueOnce({ success: true, sessions: [], launchedSessionCounts: {} });
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(0);
  });

  it('shows a remote host session running and unread, and clears both when the host reports otherwise', async () => {
    const store = createStore();
    const remote = { id: 'remote', createdAt: 1, updatedAt: 1, remoteHostDeviceId: 'studio', phase: 'validating' };
    const invoke = vi.fn()
      .mockResolvedValueOnce({ success: true, sessions: [{ ...remote, remoteExecuting: true, hasUnread: true }, { id: 'local', createdAt: 1, updatedAt: 1 }] })
      .mockResolvedValueOnce({ success: true, sessions: [{ ...remote, remoteExecuting: false, hasUnread: false }] });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionListWorkspaceAtom, '/project');
    store.set(sessionProcessingAtom('local'), true);
    await store.set(refreshSessionListAtom);
    expect([store.get(sessionProcessingAtom('remote')), store.get(sessionUnreadAtom('remote'))]).toEqual([true, true]);
    expect(store.get(sessionRegistryAtom).get('remote')?.phase).toBe('validating');
    // Local sessions keep their stream-driven state.
    expect(store.get(sessionProcessingAtom('local'))).toBe(true);
    await store.set(refreshSessionListAtom);
    expect([store.get(sessionProcessingAtom('remote')), store.get(sessionUnreadAtom('remote'))]).toEqual([false, false]);
  });

  it('ignores an older response after a newer list load or workspace change', async () => {
    const store = createStore();
    let resolveOld!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ success: true, sessions: [], launchedSessionCounts: { current: 1 } });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionListWorkspaceAtom, '/project');
    const old = store.set(refreshSessionListAtom);
    store.set(sessionListWorkspaceAtom, '/other');
    await store.set(refreshSessionListAtom);
    resolveOld({ success: true, sessions: [], launchedSessionCounts: { stale: 4 } });
    await old;
    expect(store.get(sessionLaunchCountAtom('current'))).toBe(1);
    expect(store.get(sessionLaunchCountAtom('stale'))).toBe(0);
  });
});
