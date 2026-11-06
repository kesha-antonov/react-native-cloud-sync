import { renderHook, waitFor } from '@testing-library/react-native'

import { createCloudStore, type OutboxStorage } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'
import { resolveByModifiedAt, resolveByTimestamp } from '../resolvers'
import { checkKey, sanitizeKey, SANITIZED_SUFFIX_BYTES } from '../internal/keys'
import { useCloudItems } from '../hooks'
import type { CloudProvider, CloudStoreOptions } from '../types'

function makeOutboxStorage(): OutboxStorage {
  const map = new Map<string, string>()
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

function withProviders(providers: CloudProvider[], extra: Partial<CloudStoreOptions> = {}) {
  const store = createCloudStore({
    providers: providers.map(p => p.name),
    outboxStorage: makeOutboxStorage(),
    ...extra,
  })
  for (const p of providers) store.registerProvider(p)
  return store
}

/** Writes `value` to `p` as if at time `at`, so `modifiedAt` is controlled. */
async function writeAt(p: MemoryProvider, key: string, value: string, at: number): Promise<void> {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(at)
  try {
    await p.setItem(key, value)
  }
  finally {
    spy.mockRestore()
  }
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}

const flushMicrotasks = () => new Promise(r => setTimeout(r, 0))

describe('resolving multiGet reads server timestamps, like getItem', () => {
  async function twoStores() {
    const first = createMemoryProvider({ name: 'memory' })
    const second = createMemoryProvider({ name: 'googleDrive' })
    // The preferred provider holds the OLDER copy.
    await writeAt(first, 'k', 'old', 1_000)
    await writeAt(second, 'k', 'new', 2_000)
    return { first, second }
  }

  it('multiGet and getAllItems agree with getItem', async () => {
    const { first, second } = await twoStores()
    const store = withProviders([first, second], {
      resolve: resolveByModifiedAt(),
      repairOnRead: false,
    })

    await expect(store.getItem('k')).resolves.toBe('new')
    await expect(store.multiGet(['k'])).resolves.toEqual([['k', 'new']])
    await expect(store.getAllItems()).resolves.toEqual({ k: 'new' })
  })

  it('stays one request per provider when the provider can batch timestamps', async () => {
    const { first, second } = await twoStores()
    const store = withProviders([first, second], { resolve: resolveByModifiedAt(), repairOnRead: false })
    const before = first.calls.getItem
    await store.multiGet(['k', 'other', 'third'])
    expect(first.calls.getItem - before).toBe(1)
  })

  it('falls back to per-key timestamped reads when the provider cannot batch them', async () => {
    const { first, second } = await twoStores()
    const unbatched: CloudProvider = { ...first, multiGetWithMeta: undefined }
    const store = withProviders([unbatched, second], { resolve: resolveByModifiedAt(), repairOnRead: false })

    const before = first.calls.getItem
    await expect(store.multiGet(['k', 'x'])).resolves.toEqual([['k', 'new'], ['x', null]])
    expect(first.calls.getItem - before).toBe(2)
  })

  it('keeps the plain batch for a resolver that ignores timestamps', async () => {
    const first = createMemoryProvider({ initial: { k: '{"updatedAt":1}' } })
    const unbatched: CloudProvider = { ...first, multiGetWithMeta: undefined }
    const store = withProviders([unbatched], { resolve: resolveByTimestamp(), repairOnRead: false })

    const before = first.calls.getItem
    await store.multiGet(['k', 'x', 'y'])
    expect(first.calls.getItem - before).toBe(1)
  })

  it('repairs the losing provider after a multiGet', async () => {
    const { first, second } = await twoStores()
    const store = withProviders([first, second], { resolve: resolveByModifiedAt() })

    await store.multiGet(['k'])
    await flushMicrotasks()
    expect(first.dump()).toEqual({ k: 'new' })
  })

  it('useCloudItems shows the newest copy', async () => {
    const { first, second } = await twoStores()
    const store = withProviders([first, second], { resolve: resolveByModifiedAt(), repairOnRead: false })

    const { result } = await renderHook(() =>
      useCloudItems<string>(store, ['k'], { parse: s => s, serialize: s => s }))
    await waitFor(() => expect(result.current.values).toEqual({ k: 'new' }))
  })
})

describe('a queued write and a direct write to the same key are ordered', () => {
  function heldProvider() {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 } },
    })
    const gate = deferred()
    const realSet = mem.setItem
    let hold = false
    const provider: CloudProvider = {
      ...mem,
      setItem: async (key, value) => {
        if (hold && value === 'v1') await gate.promise
        return await realSet(key, value)
      },
    }
    const startHolding = (): void => {
      hold = true
    }
    return { mem, provider, gate, startHolding }
  }

  it('a direct write issued while the queued one is in flight lands last', async () => {
    const { mem, provider, gate, startHolding } = heldProvider()
    const store = withProviders([provider])

    await store.setItem('k', 'v1') // fails once, queued
    startHolding()
    const flush = store.flushOutbox()
    await flushMicrotasks()
    const direct = store.setItem('k', 'v2')
    await flushMicrotasks()
    gate.open()
    await Promise.all([flush, direct])

    expect(mem.dump()).toEqual({ k: 'v2' })
    expect(store.pendingWrites()).toEqual([])
  })

  it('a direct write that lands first drops the queued one instead of being overwritten', async () => {
    const { mem, provider } = heldProvider()
    const store = withProviders([provider])

    await store.setItem('k', 'v1')
    const direct = store.setItem('k', 'v2')
    const flush = store.flushOutbox()
    await Promise.all([direct, flush])

    expect(mem.dump()).toEqual({ k: 'v2' })
    expect(store.pendingWrites()).toEqual([])
  })
})

describe('read repair respects the outbox', () => {
  it('drops a queued older write once the repair lands', async () => {
    const a = createMemoryProvider({ name: 'memory' })
    const b = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([a, b], {
      writeMode: 'mirror',
      resolve: resolveByTimestamp(),
    })

    // An old write that only reached `b`; `a` queued it.
    a.setFault('setItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 })
    await store.setItem('k', '{"updatedAt":1}')
    expect(store.pendingWrites()).toHaveLength(1)
    // Another device writes something newer to `b`.
    await b.setItem('k', '{"updatedAt":5}')

    await expect(store.getItem('k')).resolves.toBe('{"updatedAt":5}')
    await flushMicrotasks()
    expect(a.dump()).toEqual({ k: '{"updatedAt":5}' })
    expect(store.pendingWrites()).toEqual([])

    // So a later flush cannot put the old value back on top.
    await store.flushOutbox()
    expect(a.dump()).toEqual({ k: '{"updatedAt":5}' })
  })

  it('leaves a provider alone when its queued write would win', async () => {
    const a = createMemoryProvider({ name: 'memory', initial: { k: '{"updatedAt":1}' } })
    const b = createMemoryProvider({ name: 'googleDrive', initial: { k: '{"updatedAt":2}' } })
    const store = withProviders([a, b], { resolve: resolveByTimestamp() })

    // This device's newest value, queued for `a` and not yet anywhere.
    a.setFault('setItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 })
    await store.setItem('k', '{"updatedAt":9}')

    await store.getItem('k')
    await flushMicrotasks()
    expect(a.dump()).toEqual({ k: '{"updatedAt":1}' })
    expect(store.pendingWrites().map(e => e.value)).toEqual(['{"updatedAt":9}'])
  })

  it('does not resurrect a value with a delete still queued', async () => {
    const a = createMemoryProvider({ name: 'memory' })
    const b = createMemoryProvider({ name: 'googleDrive', initial: { k: '{"updatedAt":2}' } })
    const store = withProviders([a, b], { resolve: resolveByTimestamp() })
    a.setFault('removeItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 })
    b.setFault('removeItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 })
    await store.removeItem('k')

    await store.getItem('k')
    await flushMicrotasks()
    expect(a.dump()).toEqual({})
  })
})

describe('sanitizeKey is injective', () => {
  it('keeps distinct inputs distinct after character replacement', () => {
    expect(sanitizeKey('a b')).not.toBe(sanitizeKey('a-b'))
    expect(sanitizeKey('a-b')).toBe('a-b')
  })

  it('never lets a passed-through key equal a rewritten one', () => {
    const rewritten = sanitizeKey('a b')
    expect(sanitizeKey(rewritten)).not.toBe(rewritten)
  })

  it('honours maxBytes, down to the suffix length', () => {
    for (const max of [SANITIZED_SUFFIX_BYTES, 20, 64]) {
      const out = sanitizeKey('x'.repeat(200), max)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(checkKey(out, ['icloudKV', 'cloudKit'])).toBeNull()
    }
  })

  it('rejects a maxBytes too small to stay distinct', () => {
    expect(() => sanitizeKey('anything', SANITIZED_SUFFIX_BYTES - 1)).toThrow(RangeError)
  })

  it('produces a legal key from an empty string', () => {
    expect(checkKey(sanitizeKey(''), ['icloudKV', 'cloudKit'])).toBeNull()
  })
})
