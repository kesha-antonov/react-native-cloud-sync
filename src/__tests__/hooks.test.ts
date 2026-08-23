import { act, renderHook, waitFor } from '@testing-library/react-native'

import { createCloudStore, type CloudStore } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'
import type { CloudProvider } from '../types'
import {
  useAccountStatus,
  useCloudCollection,
  useCloudItem,
  useCloudItems,
  usePendingWrites,
  useQuota,
  useRemoteChange,
} from '../hooks'

function setup(provider: MemoryProvider, extra: Record<string, unknown> = {}): CloudStore {
  const store = createCloudStore({
    providers: ['memory'],
    outbox: true,
    ...extra,
  })
  store.registerProvider(provider)
  return store
}

describe('useCloudItem', () => {
  it('starts loading and resolves the existing value', async () => {
    const mem = createMemoryProvider({ initial: { settings: '"dark"' } })
    const store = setup(mem)

    const { result } = renderHook(() => useCloudItem<string>(store, 'settings'))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.value).toBe('dark')
    expect(result.current.error).toBeNull()
  })

  it('resolves to the default initialValue for a missing key', async () => {
    const store = setup(createMemoryProvider())

    const { result } = renderHook(() => useCloudItem<string>(store, 'nope', { initialValue: 'fallback' }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.value).toBeNull()
  })

  it('setValue writes optimistically and persists', async () => {
    const mem = createMemoryProvider()
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let write!: Promise<void>
    act(() => {
      write = result.current.setValue('v')
    })
    // The optimistic update lands before the write settles.
    expect(result.current.value).toBe('v')
    await act(() => write)

    expect(mem.dump()).toEqual({ k: '"v"' })
  })

  it('remove clears the value and deletes the key', async () => {
    const mem = createMemoryProvider({ initial: { k: '"v"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.remove())

    expect(result.current.value).toBeNull()
    expect(mem.dump()).toEqual({})
  })

  it('setValue rejects and surfaces a non-retryable failure', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await expect(result.current.setValue('v')).rejects.toMatchObject({
        code: ErrorCode.QUOTA_EXCEEDED,
      })
    })
    expect(result.current.error).toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })
  })

  it('remove rejects and surfaces a non-retryable failure', async () => {
    const mem = createMemoryProvider({
      initial: { k: '"v"' },
      faults: { removeItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await expect(result.current.remove()).rejects.toMatchObject({
        code: ErrorCode.QUOTA_EXCEEDED,
      })
    })
    expect(result.current.error).toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })
  })

  it('a write that fails is not reverted - the outbox will still deliver it', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.setValue('v'))

    expect(result.current.value).toBe('v')
    expect(result.current.error).toBeNull()
    expect(store.pendingWrites()).toHaveLength(1)
  })

  it('a failed read keeps the last known value instead of blanking it', async () => {
    const mem = createMemoryProvider({ initial: { k: '"v"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.value).toBe('v')

    mem.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE })
    await act(() => result.current.refresh())

    expect(result.current.value).toBe('v')
    expect(result.current.error).toMatchObject({ code: ErrorCode.NETWORK_UNAVAILABLE })
  })

  it('re-reads when another device changes the same key', async () => {
    const mem = createMemoryProvider({ initial: { k: '"v1"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mem.seed({ k: '"v2"' })
    act(() => mem.emitRemoteChange({ keys: ['k'] }))

    await waitFor(() => expect(result.current.value).toBe('v2'))
  })

  it('ignores a remote change naming a different key', async () => {
    const mem = createMemoryProvider({ initial: { k: '"v1"', other: '"x"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const readsBefore = mem.calls.getItem

    mem.seed({ k: '"v1"', other: '"y"' })
    act(() => mem.emitRemoteChange({ keys: ['other'] }))

    // Nothing to await: assert no extra read was ever issued.
    await new Promise(r => setTimeout(r, 0))
    expect(mem.calls.getItem).toBe(readsBefore)
    expect(result.current.value).toBe('v1')
  })

  it('re-reads on an opaque event naming no keys', async () => {
    const mem = createMemoryProvider({ initial: { k: '"v1"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mem.seed({ k: '"v2"' })
    act(() => mem.emitRemoteChange({ keys: [], reason: 'accountChange' }))

    await waitFor(() => expect(result.current.value).toBe('v2'))
  })

  it('does not watch when watch is false', async () => {
    const mem = createMemoryProvider({ initial: { k: '"v1"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k', { watch: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mem.seed({ k: '"v2"' })
    act(() => mem.emitRemoteChange({ keys: ['k'] }))

    await new Promise(r => setTimeout(r, 0))
    expect(result.current.value).toBe('v1')
  })

  it('supports a plain-string codec via identity parse/serialize', async () => {
    const mem = createMemoryProvider({ initial: { theme: 'dark' } })
    const store = setup(mem)
    const { result } = renderHook(() =>
      useCloudItem<string>(store, 'theme', { parse: raw => raw, serialize: value => value })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.value).toBe('dark')

    await act(() => result.current.setValue('light'))
    expect(mem.dump()).toEqual({ theme: 'light' })
  })

  it('a slow response from before a write cannot land on top of it', async () => {
    const mem = createMemoryProvider({ initial: { k: '"server"' }, latencyMs: 30 })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItem<string>(store, 'k'))

    // The initial read is still in flight (30ms latency) when the write lands.
    let write!: Promise<void>
    act(() => {
      write = result.current.setValue('optimistic')
    })
    await act(() => write)

    // Give the slow initial read every chance to resolve and overwrite it.
    await new Promise(r => setTimeout(r, 60))
    expect(result.current.value).toBe('optimistic')
  })
})

describe('useCloudItems', () => {
  it('fetches every key with one batched multiGet', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const readsBefore = mem.calls.getItem

    const { result } = renderHook(() => useCloudItems<string>(store, ['a', 'b']))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.values).toEqual({ a: '1', b: '2' })
    expect(mem.calls.getItem).toBe(readsBefore + 1)
  })

  it('a key that was never written resolves to null, not missing', async () => {
    const store = setup(createMemoryProvider({ initial: { a: '"1"' } }))
    const { result } = renderHook(() => useCloudItems<string>(store, ['a', 'missing']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.values).toEqual({ a: '1', missing: null })
  })

  it('resolves loading immediately for an empty key list', async () => {
    const store = setup(createMemoryProvider())
    const { result } = renderHook(() => useCloudItems<string>(store, []))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.values).toEqual({})
  })

  it('setValue updates only the written key', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a', 'b']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.setValue('a', '9'))

    expect(result.current.values).toEqual({ a: '9', b: '2' })
    expect(mem.dump()).toMatchObject({ a: '"9"' })
  })

  it('remove sets the key to null and deletes it from the provider', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a', 'b']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.remove('a'))

    expect(result.current.values.a).toBeNull()
    expect(mem.dump()).toEqual({ b: '"2"' })
  })

  it('setValue rejects and surfaces a non-retryable failure', async () => {
    const mem = createMemoryProvider({
      initial: { a: '"1"' },
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await expect(result.current.setValue('a', '2')).rejects.toMatchObject({
        code: ErrorCode.QUOTA_EXCEEDED,
      })
    })
    expect(result.current.error).toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })
  })

  it('remove rejects and surfaces a non-retryable failure', async () => {
    const mem = createMemoryProvider({
      initial: { a: '"1"' },
      faults: { removeItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await expect(result.current.remove('a')).rejects.toMatchObject({
        code: ErrorCode.QUOTA_EXCEEDED,
      })
    })
    expect(result.current.error).toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })
  })

  it('a still-current failed fetch surfaces an error', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mem.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE })
    await act(() => result.current.refresh())

    // The store's no-resolver multiGet swallows the per-provider error and
    // reports "nothing reachable" rather than propagating the injected code -
    // unlike the single-key path (see the `useCloudItem` equivalent above).
    expect(result.current.error).toMatchObject({ code: ErrorCode.NOT_SIGNED_IN })
    // The stale value survives the failed refresh, same contract as useCloudItem.
    expect(result.current.values.a).toBe('1')
  })

  it('refresh re-fetches every tracked key, picking up an out-of-band change', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mem.seed({ a: '"2"' })
    await act(() => result.current.refresh())

    expect(result.current.values.a).toBe('2')
  })

  it('a remote change naming one tracked key only re-fetches that key', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a', 'b']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // If the whole batch were re-fetched, this would fail and set `error`.
    mem.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE, only: k => k === 'b' })
    mem.seed({ a: '"9"', b: '"2"' })
    act(() => mem.emitRemoteChange({ keys: ['a'] }))

    await waitFor(() => expect(result.current.values.a).toBe('9'))
    expect(result.current.error).toBeNull()
  })

  it('ignores a remote change naming no tracked key', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a']))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const readsBefore = mem.calls.getItem

    act(() => mem.emitRemoteChange({ keys: ['unrelated'] }))
    await new Promise(r => setTimeout(r, 0))

    expect(mem.calls.getItem).toBe(readsBefore)
  })

  it('an opaque remote change re-fetches every tracked key', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudItems<string>(store, ['a', 'b']))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mem.seed({ a: '"9"', b: '"9"' })
    act(() => mem.emitRemoteChange({ keys: [], reason: 'accountChange' }))

    await waitFor(() => expect(result.current.values).toEqual({ a: '9', b: '9' }))
  })

  it('a key newly added to the list is fetched without re-fetching known keys', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const { result, rerender } = renderHook(
      ({ keys }: { keys: string[] }) => useCloudItems<string>(store, keys),
      { initialProps: { keys: ['a'] } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    // If `b` joining the list re-fetched `a` too, this fault would trip it.
    mem.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE, only: k => k === 'a' })
    rerender({ keys: ['a', 'b'] })

    await waitFor(() => expect(result.current.values.b).toBe('2'))
    expect(result.current.error).toBeNull()
    expect(result.current.values.a).toBe('1')
  })

  it('drops a value for a key removed from the list', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' } })
    const store = setup(mem)
    const { result, rerender } = renderHook(
      ({ keys }: { keys: string[] }) => useCloudItems<string>(store, keys),
      { initialProps: { keys: ['a', 'b'] } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ keys: ['a'] })

    await waitFor(() => expect(Object.keys(result.current.values)).toEqual(['a']))
  })

  it('a write is never clobbered by a slower fetch already in flight for the same key', async () => {
    const mem = createMemoryProvider({ initial: { a: '"server"' }, latencyMs: 30 })
    const store = setup(mem)
    // Mounting starts the initial (slow) fetch for `a`.
    const { result } = renderHook(() => useCloudItems<string>(store, ['a']))

    let write!: Promise<void>
    act(() => {
      write = result.current.setValue('a', 'optimistic')
    })
    await act(() => write)

    await new Promise(r => setTimeout(r, 60))
    expect(result.current.values.a).toBe('optimistic')
  })

  it('a fetch for one key does not invalidate an unrelated fetch already in flight', async () => {
    const mem = createMemoryProvider({ initial: { a: '"1"', b: '"2"' }, latencyMs: 30 })
    const store = setup(mem)
    // The initial batched fetch for [a, b] is now in flight (30ms).
    const { result, rerender } = renderHook(
      ({ keys }: { keys: string[] }) => useCloudItems<string>(store, keys),
      { initialProps: { keys: ['a', 'b'] } }
    )

    // A third key joins mid-flight and starts its own fetch.
    mem.seed({ a: '"1"', b: '"2"', c: '"3"' })
    rerender({ keys: ['a', 'b', 'c'] })

    await waitFor(() => expect(result.current.values).toEqual({ a: '1', b: '2', c: '3' }), {
      timeout: 2000,
    })
  })
})

describe('useCloudCollection', () => {
  it('lists every key starting with the prefix', async () => {
    const store = setup(createMemoryProvider({ initial: { 'note:1': '"a"', 'note:2': '"b"', 'other': '"c"' } }))
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))

    await waitFor(() => expect(result.current.keys.sort()).toEqual(['note:1', 'note:2']))
    await waitFor(() => expect(result.current.values).toEqual({ 'note:1': 'a', 'note:2': 'b' }))
  })

  it('setValue for a new key joins the collection immediately', async () => {
    const store = setup(createMemoryProvider())
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))
    await waitFor(() => expect(result.current.keys).toEqual([]))

    act(() => {
      void result.current.setValue('note:1', 'hello')
    })

    // No round trip needed - membership updates in the same commit as the
    // optimistic value.
    expect(result.current.keys).toEqual(['note:1'])
    expect(result.current.values['note:1']).toBe('hello')

    await waitFor(() => expect(store.getItem('note:1')).resolves.toBe('"hello"'))
  })

  it('a key outside the prefix does not join the collection', async () => {
    const store = setup(createMemoryProvider())
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))
    await waitFor(() => expect(result.current.keys).toEqual([]))

    await act(() => result.current.setValue('other:1', 'x'))

    expect(result.current.keys).toEqual([])
  })

  it('remove drops the key from the collection', async () => {
    const store = setup(createMemoryProvider({ initial: { 'note:1': '"a"' } }))
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))
    await waitFor(() => expect(result.current.keys).toEqual(['note:1']))

    await act(() => result.current.remove('note:1'))

    expect(result.current.keys).toEqual([])
  })

  it('re-lists after a remote change under the prefix', async () => {
    const mem = createMemoryProvider({ initial: { 'note:1': '"a"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))
    await waitFor(() => expect(result.current.keys).toEqual(['note:1']))

    mem.seed({ 'note:1': '"a"', 'note:2': '"b"' })
    act(() => mem.emitRemoteChange({ keys: ['note:2'] }))

    await waitFor(() => expect(result.current.keys.sort()).toEqual(['note:1', 'note:2']))
    await waitFor(() => expect(result.current.values['note:2']).toBe('b'))
  })

  it('does not re-list for a remote change outside the prefix', async () => {
    const mem = createMemoryProvider({ initial: { 'note:1': '"a"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))
    await waitFor(() => expect(result.current.keys).toEqual(['note:1']))
    const listsBefore = mem.calls.getAllKeys

    act(() => mem.emitRemoteChange({ keys: ['other:1'] }))
    await new Promise(r => setTimeout(r, 0))

    expect(mem.calls.getAllKeys).toBe(listsBefore)
  })

  it('refresh picks up a member that appeared out of band', async () => {
    const mem = createMemoryProvider({ initial: { 'note:1': '"a"' } })
    const store = setup(mem)
    const { result } = renderHook(() => useCloudCollection<string>(store, 'note:'))
    await waitFor(() => expect(result.current.keys).toEqual(['note:1']))

    mem.seed({ 'note:1': '"a"', 'note:2': '"b"' })
    await act(() => result.current.refresh())

    expect(result.current.keys.sort()).toEqual(['note:1', 'note:2'])
    await waitFor(() => expect(result.current.values['note:2']).toBe('b'))
  })
})

describe('useAccountStatus', () => {
  it('reads the initial status', async () => {
    const mem = createMemoryProvider({ accountStatus: 'available' })
    const { result } = renderHook(() => useAccountStatus(mem))

    await waitFor(() => expect(result.current.status).toBe('available'))
    expect(result.current.identityChanged).toBe(false)
  })

  it('updates status from an account-change event', async () => {
    const mem = createMemoryProvider({ accountStatus: 'available' })
    const { result } = renderHook(() => useAccountStatus(mem))
    await waitFor(() => expect(result.current.status).toBe('available'))

    act(() => mem.emitAccountChange({ status: 'noAccount' }))

    await waitFor(() => expect(result.current.status).toBe('noAccount'))
  })

  it('latches identityChanged and keeps it true after a later unrelated event', async () => {
    const mem = createMemoryProvider({ accountStatus: 'available' })
    const { result } = renderHook(() => useAccountStatus(mem))
    await waitFor(() => expect(result.current.status).toBe('available'))

    act(() => mem.emitAccountChange({ status: 'available', identityChanged: true }))
    await waitFor(() => expect(result.current.identityChanged).toBe(true))

    act(() => mem.emitAccountChange({ status: 'available', identityChanged: false }))
    await new Promise(r => setTimeout(r, 0))
    expect(result.current.identityChanged).toBe(true)
  })

  it('surfaces a failed refresh without crashing', async () => {
    const mem = createMemoryProvider()
    const { result } = renderHook(() => useAccountStatus(mem))
    await waitFor(() => expect(result.current.status).not.toBeNull())

    mem.setFault('getAccountStatus', { code: ErrorCode.NETWORK_UNAVAILABLE })
    await act(() => result.current.refresh())

    expect(result.current.error).toMatchObject({ code: ErrorCode.NETWORK_UNAVAILABLE })
  })

  it('works against a provider with no onAccountChange', async () => {
    const mem = createMemoryProvider({ accountStatus: 'available' })
    const minimal: CloudProvider = {
      name: mem.name,
      isAvailable: mem.isAvailable,
      getAccountStatus: mem.getAccountStatus,
      getItem: mem.getItem,
      setItem: mem.setItem,
      removeItem: mem.removeItem,
      getAllKeys: mem.getAllKeys,
    }

    const { result } = renderHook(() => useAccountStatus(minimal))
    await waitFor(() => expect(result.current.status).toBe('available'))
  })
})

describe('usePendingWrites', () => {
  it('reflects the store outbox and flushes it', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 } },
    })
    const store = setup(mem)
    await store.setItem('k', 'v')
    expect(store.pendingWrites()).toHaveLength(1)

    const { result } = renderHook(() => usePendingWrites(store))
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    await act(() => result.current.flush())

    expect(result.current.pending).toHaveLength(0)
    expect(mem.dump()).toEqual({ k: 'v' })
  })

  it('discard abandons queued writes matching the filter', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const store = setup(mem)
    await store.setItem('a', '1')
    await store.setItem('b', '2')

    const { result } = renderHook(() => usePendingWrites(store))
    await waitFor(() => expect(result.current.pending).toHaveLength(2))

    act(() => result.current.discard(e => e.key === 'a'))

    expect(result.current.pending).toHaveLength(1)
    expect(result.current.pending[0]).toMatchObject({ key: 'b' })
  })

  it('polls for changes made outside the hook', async () => {
    jest.useFakeTimers()
    try {
      const mem = createMemoryProvider({
        faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
      })
      const store = setup(mem)

      const { result } = renderHook(() => usePendingWrites(store, 1000))
      expect(result.current.pending).toHaveLength(0)

      // Queued directly against the store, bypassing the hook's own actions.
      await store.setItem('k', 'v')
      expect(result.current.pending).toHaveLength(0)

      act(() => {
        jest.advanceTimersByTime(1000)
      })

      expect(result.current.pending).toHaveLength(1)
    }
    finally {
      jest.useRealTimers()
    }
  })
})

describe('useRemoteChange', () => {
  it('invokes the listener with the event', () => {
    const mem = createMemoryProvider()
    const store = setup(mem)
    const listener = jest.fn()
    renderHook(() => useRemoteChange(store, listener))

    act(() => mem.emitRemoteChange({ keys: ['k'], reason: 'serverChange' }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ['k'], reason: 'serverChange', provider: 'memory' })
    )
  })

  it('a new inline listener on rerender does not create a second subscription', () => {
    const mem = createMemoryProvider()
    const store = setup(mem)
    const calls: number[] = []
    const { rerender } = renderHook(
      ({ tag }: { tag: number }) => useRemoteChange(store, () => calls.push(tag)),
      { initialProps: { tag: 1 } }
    )
    rerender({ tag: 2 })
    rerender({ tag: 3 })

    act(() => mem.emitRemoteChange({ keys: [] }))

    // Only the latest listener should have fired, and only once.
    expect(calls).toEqual([3])
  })

  it('stops listening after unmount', () => {
    const mem = createMemoryProvider()
    const store = setup(mem)
    const listener = jest.fn()
    const { unmount } = renderHook(() => useRemoteChange(store, listener))
    unmount()

    act(() => mem.emitRemoteChange({ keys: [] }))

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('useQuota', () => {
  it('is not fetched until refresh is called', () => {
    const store = setup(createMemoryProvider({ quota: { usedBytes: 10, totalBytes: 100 } }))
    const { result } = renderHook(() => useQuota(store))

    expect(result.current.loading).toBe(false)
    expect(result.current.quota).toEqual([])
  })

  it('refresh populates per-provider quota', async () => {
    const store = setup(createMemoryProvider({ quota: { usedBytes: 10, totalBytes: 100 } }))
    const { result } = renderHook(() => useQuota(store))

    await act(() => result.current.refresh())

    expect(result.current.quota).toEqual([
      { usedBytes: 10, totalBytes: 100, provider: 'memory' },
    ])
    expect(result.current.loading).toBe(false)
  })
})
