import { createCloudStore, type OutboxStorage } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'
import { resolveByModifiedAt, resolveByTimestamp, resolveFirstOf } from '../resolvers'
import type { CloudStoreOptions } from '../types'

function makeOutboxStorage(): OutboxStorage {
  const map = new Map<string, string>()
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

function withProviders(providers: MemoryProvider[], extra: Partial<CloudStoreOptions> = {}) {
  const store = createCloudStore({
    providers: providers.map(p => p.name),
    outboxStorage: makeOutboxStorage(),
    ...extra,
  })
  for (const p of providers) store.registerProvider(p)
  return store
}

/** A gate the test opens by hand, to hold a provider call mid-flight. */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}

describe('flushOutbox and writes that race it', () => {
  it('keeps a newer write for the same key queued while the flush was in flight', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const store = withProviders([mem])

    await store.setItem('k', 'v1')
    expect(store.pendingWrites()).toHaveLength(1)

    // Hold the flush's retry of v1 on the wire.
    const gate = deferred()
    const realSet = mem.setItem
    let first = true
    mem.setItem = async (key, value) => {
      if (first) {
        first = false
        await gate.promise
      }
      return await realSet(key, value)
    }
    store.registerProvider(mem)

    const flush = store.flushOutbox()
    await Promise.resolve()
    // v2 fails too and is queued, replacing v1's entry for the same key. It
    // waits for the flush's in-flight v1 to settle first - see the ordering
    // tests below.
    const write = store.setItem('k', 'v2')
    gate.open()
    await Promise.all([flush, write])

    const pending = store.pendingWrites()
    expect(pending.map(e => e.value)).toEqual(['v2'])
  })

  it('does not write back an entry discarded while the flush was in flight', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const store = withProviders([mem])
    await store.setItem('a', '1')
    await store.setItem('b', '2')

    const gate = deferred()
    const realSet = mem.setItem
    mem.setItem = async (key, value) => {
      if (key === 'a') await gate.promise
      return await realSet(key, value)
    }
    store.registerProvider(mem)

    const flush = store.flushOutbox()
    await Promise.resolve()
    // The user gives up on 'b' while 'a' is still being retried.
    expect(store.discardPendingWrites(e => e.key === 'b')).toBe(1)
    gate.open()
    const result = await flush

    // 'a' failed again and stays; 'b' was discarded and must stay gone.
    expect(store.pendingWrites().map(e => e.key)).toEqual(['a'])
    expect(result.remaining).toBe(1)
  })

  it('does not send queued writes after an account switch empties the queue mid-flush', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const store = withProviders([mem])
    store.onAccountChange(() => undefined)
    await store.setItem('a', 'old-user-a')
    await store.setItem('b', 'old-user-b')
    mem.setFault('setItem', null)

    const gate = deferred()
    const realSet = mem.setItem
    mem.setItem = async (key, value) => {
      if (key === 'a') await gate.promise
      return await realSet(key, value)
    }
    store.registerProvider(mem)

    const flush = store.flushOutbox()
    await Promise.resolve()
    mem.emitAccountChange({ identityChanged: true })
    gate.open()
    await flush

    // 'a' was already on the wire; 'b' belonged to the previous user and must
    // never reach the new account.
    expect(mem.dump()).not.toHaveProperty('b')
    expect(store.pendingWrites()).toEqual([])
  })
})

describe('failover with tiering', () => {
  it('evicts the stale small copy when a value grows past the preferred provider', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([small, big], { tiering: { kvMaxBytes: 16, recordMaxBytes: 1024 } })

    await store.setItem('k', 'short')
    const long = 'x'.repeat(64)
    await store.setItem('k', long)

    expect(small.dump()).toEqual({})
    await expect(store.getItem('k')).resolves.toBe(long)
  })

  it('multiSet evicts the same stale copy', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([small, big], { tiering: { kvMaxBytes: 16, recordMaxBytes: 1024 } })

    await store.setItem('k', 'short')
    const long = 'x'.repeat(64)
    await store.multiSet([['k', long]])

    await expect(store.getItem('k')).resolves.toBe(long)
  })

  it('removeItem deletes a value tiering routed past the preferred provider', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([small, big], { tiering: { kvMaxBytes: 16, recordMaxBytes: 1024 } })

    await store.setItem('k', 'x'.repeat(64))
    await store.removeItem('k')

    expect(big.dump()).toEqual({})
    await expect(store.getItem('k')).resolves.toBeNull()
  })

  it('removeItem deletes a copy written while the preferred provider was down', async () => {
    const a = createMemoryProvider({ name: 'memory' })
    const b = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([a, b], { availabilityTtlMs: 0 })

    a.setAvailable(false)
    await store.setItem('k', 'v')
    expect(b.dump()).toEqual({ k: 'v' })
    a.setAvailable(true)

    await store.multiRemove(['k'])
    await expect(store.getItem('k')).resolves.toBeNull()
  })

  it('applies the record ceiling to cloudKitEncrypted as well as cloudKit', async () => {
    const enc = createMemoryProvider({ name: 'cloudKitEncrypted' })
    const drive = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([enc, drive], {
      tiering: { kvMaxBytes: 16, recordMaxBytes: 32 },
      validateKeys: false,
    })

    const long = 'x'.repeat(64)
    await store.setItem('k', long)

    expect(enc.dump()).toEqual({})
    expect(drive.dump()).toEqual({ k: long })
  })
})

describe('migrate', () => {
  it('attributes a destination failure to the destination provider', async () => {
    const src = createMemoryProvider({ name: 'memory', initial: { k: 'v' } })
    const dst = createMemoryProvider({ name: 'googleDrive' })
    // A raw rejection, the kind `normalizeError` has to attribute itself.
    dst.setItem = () => Promise.reject(new Error('socket closed'))
    const store = withProviders([src, dst])

    const result = await store.migrate({ from: 'memory', to: 'googleDrive' })
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error.provider).toBe('googleDrive')
  })
})

describe('resolver composition', () => {
  const undated = [
    { provider: 'a', value: '{"updatedAt":1}' },
    { provider: 'b', value: '{"updatedAt":9}' },
  ]

  it('resolveByModifiedAt never declines, so resolveFirstOf cannot fall through past it', () => {
    // Pinned so nobody reintroduces this as the recommended composition.
    expect(resolveFirstOf(resolveByModifiedAt(), resolveByTimestamp('updatedAt'))(undated))
      .toBe('{"updatedAt":1}')
  })

  it('the documented composition falls back to the embedded timestamp', () => {
    expect(resolveByModifiedAt({ fallback: resolveByTimestamp('updatedAt') })(undated))
      .toBe('{"updatedAt":9}')
  })
})

describe('autoFlush interval', () => {
  const rn = (globalThis as unknown as { __RNCloudSync: { setAppState: (s: string) => void } })
    .__RNCloudSync

  afterEach(() => {
    rn.setAppState('active')
    jest.useRealTimers()
  })

  it('only ticks while the app is in the foreground', () => {
    jest.useFakeTimers()
    const store = createCloudStore({
      providers: ['memory'],
      autoFlush: { onForeground: false, intervalMs: 1000 },
    })
    store.registerProvider(createMemoryProvider())
    // The timer calls `store.flushOutbox()` by property, so the spy sees it.
    const flush = jest.spyOn(store, 'flushOutbox')

    rn.setAppState('background')
    jest.advanceTimersByTime(3000)
    expect(flush).not.toHaveBeenCalled()

    rn.setAppState('active')
    jest.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
    store.dispose()
  })
})
