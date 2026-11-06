import { act, renderHook, waitFor } from '@testing-library/react-native'

import { createCloudStore, type OutboxStorage } from '../store'
import { createMemoryProvider } from '../providers/memory'
import { useCloudItems } from '../hooks'
import { ErrorCode } from '../errors'
import { MAX_RETRY_AFTER_MS } from '../internal/records'

function makeOutboxStorage(initial?: string): OutboxStorage & { raw: () => string | undefined } {
  let value = initial
  return {
    getString: () => value,
    set: (_k: string, v: string) => {
      value = v
    },
    raw: () => value,
  }
}

describe('outbox: cloudKitEncrypted plaintext never reaches durable storage', () => {
  it('queues a failed encrypted write in memory only', async () => {
    const enc = createMemoryProvider({
      name: 'cloudKitEncrypted',
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 } },
    })
    const outboxStorage = makeOutboxStorage()
    const store = createCloudStore({ providers: ['cloudKitEncrypted'], outboxStorage })
    store.registerProvider(enc)

    await store.setItem('pin', 'SECRET-PLAINTEXT')

    // Still queued and still retried...
    expect(store.pendingWrites()).toHaveLength(1)
    expect(outboxStorage.raw() ?? '').not.toContain('SECRET-PLAINTEXT')

    const result = await store.flushOutbox()
    expect(result.drained).toBe(1)
    expect(await enc.getItem('pin')).toBe('SECRET-PLAINTEXT')
  })

  it('keeps persisting other providers\' entries', async () => {
    const plain = createMemoryProvider({ faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } } })
    const outboxStorage = makeOutboxStorage()
    const store = createCloudStore({ providers: ['memory'], outboxStorage })
    store.registerProvider(plain)

    await store.setItem('k', 'v')
    expect(outboxStorage.raw()).toContain('"v"')
  })

  it('scrubs plaintext an earlier version persisted', () => {
    const legacy = JSON.stringify([
      { key: 'pin', value: 'OLD-SECRET', provider: 'cloudKitEncrypted', attempts: 0, nextAttemptAt: 0, enqueuedAt: 1 },
      { key: 'k', value: 'v', provider: 'memory', attempts: 0, nextAttemptAt: 0, enqueuedAt: 1 },
    ])
    const outboxStorage = makeOutboxStorage(legacy)
    const store = createCloudStore({ providers: ['cloudKitEncrypted', 'memory'], outboxStorage })

    expect(outboxStorage.raw()).not.toContain('OLD-SECRET')
    expect(store.pendingWrites().map(e => e.key).sort()).toEqual(['k', 'pin'])
  })
})

describe('outbox robustness', () => {
  it('skips malformed entries rather than throwing on every write', async () => {
    const outboxStorage = makeOutboxStorage(JSON.stringify([null, 7, { key: 1 }]))
    const store = createCloudStore({ providers: ['memory'], outboxStorage })
    store.registerProvider(createMemoryProvider())

    expect(store.pendingWrites()).toEqual([])
    await expect(store.setItem('k', 'v')).resolves.toBeUndefined()
  })

  it('caps a provider-supplied retry delay', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.RATE_LIMITED, retryAfterMs: 10 * 365 * 24 * 3600_000 } },
    })
    const store = createCloudStore({ providers: ['memory'], outboxStorage: makeOutboxStorage() })
    store.registerProvider(mem)

    await store.setItem('k', 'v')
    await store.flushOutbox()
    const [entry] = store.pendingWrites()
    expect(entry.nextAttemptAt - Date.now()).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS)
  })
})

describe('prototype-safe records', () => {
  it('getAllItems keeps a key named __proto__ as an own entry', async () => {
    const mem = createMemoryProvider({ initial: {} })
    const store = createCloudStore({ providers: ['memory'], validateKeys: false })
    store.registerProvider(mem)
    await mem.setItem('__proto__', '{"polluted":true}')
    await mem.setItem('a', '1')

    const items = await store.getAllItems()
    expect(Object.getPrototypeOf(items)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(items, '__proto__')).toBe(true)
    expect(items.a).toBe('1')
  })

  it('useCloudItems loads keys that collide with Object.prototype and cannot reparent its record', async () => {
    const mem = createMemoryProvider({
      // Computed key: a literal `'__proto__':` would set the prototype instead.
      initial: { constructor: '"c"', ['__proto__']: '{"isAdmin":true}' },
    })
    const store = createCloudStore({ providers: ['memory'], validateKeys: false })
    store.registerProvider(mem)

    const { result } = await renderHook(() =>
      useCloudItems<unknown>(store, ['constructor', '__proto__'], { watch: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await Promise.resolve()
    })

    const values: Record<string, unknown> = result.current.values
    expect(Object.prototype.hasOwnProperty.call(values, 'constructor')).toBe(true)
    expect(values.constructor).toBe('c')
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
    expect((values as { isAdmin?: unknown }).isAdmin).toBeUndefined()
  })
})
