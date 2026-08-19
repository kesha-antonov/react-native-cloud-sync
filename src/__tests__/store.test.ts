import { createCloudStore, type OutboxStorage } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'

function makeOutboxStorage(): OutboxStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v)
    },
    dump: () => Object.fromEntries(map),
  }
}

function setup(provider: MemoryProvider, extra: Record<string, unknown> = {}) {
  const outboxStorage = makeOutboxStorage()
  const store = createCloudStore({
    providers: ['memory'],
    outboxStorage,
    ...extra,
  })
  store.registerProvider(provider)
  return { store, outboxStorage }
}

describe('basic round trip', () => {
  it('writes and reads through the configured provider', async () => {
    const mem = createMemoryProvider()
    const { store } = setup(mem)

    await store.setItem('k', 'v')
    await expect(store.getItem('k')).resolves.toBe('v')
    expect(mem.dump()).toEqual({ k: 'v' })
  })

  it('returns null for a missing key rather than throwing', async () => {
    const { store } = setup(createMemoryProvider())
    await expect(store.getItem('nope')).resolves.toBeNull()
  })
})

describe('outbox', () => {
  it('queues a write that failed for a retryable reason instead of losing it', async () => {
    // This is the failure react-native-cloud-storage documents as expected
    // behaviour: an airplane-mode write "succeeds" with no error and no queue,
    // so the data is simply gone.
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = setup(mem)

    await store.setItem('k', 'v')

    expect(mem.dump()).toEqual({})
    const pending = store.pendingWrites()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ key: 'k', value: 'v', provider: 'memory' })
  })

  it('drains the queue once the failure clears', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 } },
    })
    const { store } = setup(mem)

    await store.setItem('k', 'v')
    expect(store.pendingWrites()).toHaveLength(1)

    const result = await store.flushOutbox()

    expect(result).toEqual({ drained: 1, remaining: 0 })
    expect(mem.dump()).toEqual({ k: 'v' })
    expect(store.pendingWrites()).toHaveLength(0)
  })

  it('does not queue a failure the user must act on - it surfaces it', async () => {
    // Queuing a quota-exceeded write would retry forever and never tell anyone.
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const { store } = setup(mem)

    await expect(store.setItem('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
    })
    expect(store.pendingWrites()).toHaveLength(0)
  })

  it('backs off rather than hammering a still-failing provider', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = setup(mem)

    await store.setItem('k', 'v')
    const before = mem.calls.setItem

    const first = await store.flushOutbox()
    expect(first).toEqual({ drained: 0, remaining: 1 })
    expect(mem.calls.setItem).toBe(before + 1)

    // Second flush is inside the backoff window, so it must not retry yet.
    const second = await store.flushOutbox()
    expect(second).toEqual({ drained: 0, remaining: 1 })
    expect(mem.calls.setItem).toBe(before + 1)
  })

  it('honours a server-supplied retry hint', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.RATE_LIMITED, retryAfterMs: 90_000 } },
    })
    const { store } = setup(mem)

    await store.setItem('k', 'v')
    await store.flushOutbox()

    const [entry] = store.pendingWrites()
    // ~90s out, rather than the 2s the generic backoff would have chosen.
    expect(entry.nextAttemptAt - Date.now()).toBeGreaterThan(80_000)
  })

  it('can be turned off, in which case failures always throw', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = setup(mem, { outbox: false })

    await expect(store.setItem('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.NETWORK_UNAVAILABLE,
    })
    expect(store.pendingWrites()).toHaveLength(0)
  })
})

describe('migrate', () => {
  it('copies every key from one provider to another', async () => {
    const from = createMemoryProvider({ initial: { a: '1', b: '2' } })
    const to = createMemoryProvider()
    // Two providers of the same name cannot coexist, so relabel the target.
    const target = { ...to, name: 'googleDrive' as const }

    const store = createCloudStore({ providers: ['memory', 'googleDrive'] })
    store.registerProvider(from)
    store.registerProvider(target)

    const { copied } = await store.migrate({ from: 'memory', to: 'googleDrive' })

    expect(copied.sort()).toEqual(['a', 'b'])
    expect(to.dump()).toEqual({ a: '1', b: '2' })
    // Source is left intact - migration is a copy, not a move.
    expect(from.dump()).toEqual({ a: '1', b: '2' })
  })
})

describe('provider fallthrough', () => {
  it('reads from a later provider when the first has no value', async () => {
    const first = createMemoryProvider()
    const second = { ...createMemoryProvider({ initial: { k: 'from-drive' } }), name: 'googleDrive' as const }

    const store = createCloudStore({ providers: ['memory', 'googleDrive'] })
    store.registerProvider(first)
    store.registerProvider(second)

    await expect(store.getItem('k')).resolves.toBe('from-drive')
  })
})

describe('write modes', () => {
  function twoProviders() {
    const apple = createMemoryProvider()
    const driveBase = createMemoryProvider()
    const drive = { ...driveBase, name: 'googleDrive' as const }
    return { apple, driveBase, drive }
  }

  it('failover writes to the first available provider ONLY', () => {
    // The default. Worth pinning explicitly, because the natural reading of
    // providers: ['icloudKV', 'googleDrive'] is "both", and it is not.
    const { apple, driveBase, drive } = twoProviders()
    const store = createCloudStore({ providers: ['memory', 'googleDrive'] })
    store.registerProvider(apple)
    store.registerProvider(drive)

    return store.setItem('k', 'v').then(() => {
      expect(apple.dump()).toEqual({ k: 'v' })
      // Nothing reached the second provider - so a device that can only read
      // that one would find nothing.
      expect(driveBase.dump()).toEqual({})
    })
  })

  it('mirror writes to every available provider', async () => {
    const { apple, driveBase, drive } = twoProviders()
    const store = createCloudStore({
      providers: ['memory', 'googleDrive'],
      writeMode: 'mirror',
    })
    store.registerProvider(apple)
    store.registerProvider(drive)

    await store.setItem('k', 'v')

    expect(apple.dump()).toEqual({ k: 'v' })
    expect(driveBase.dump()).toEqual({ k: 'v' })
  })

  it('mirror succeeds when one destination is down, and queues that one', async () => {
    const apple = createMemoryProvider()
    const driveBase = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const drive = { ...driveBase, name: 'googleDrive' as const }

    const outboxStorage = makeOutboxStorage()
    const store = createCloudStore({
      providers: ['memory', 'googleDrive'],
      writeMode: 'mirror',
      outboxStorage,
    })
    store.registerProvider(apple)
    store.registerProvider(drive)

    // One good copy plus a queued retry beats rejecting a write the user has
    // already been told about.
    await expect(store.setItem('k', 'v')).resolves.toBeUndefined()

    expect(apple.dump()).toEqual({ k: 'v' })
    const pending = store.pendingWrites()
    expect(pending).toHaveLength(1)
    expect(pending[0].provider).toBe('googleDrive')
  })

  it('mirror rejects when nothing stored the value', async () => {
    const apple = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const driveBase = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const drive = { ...driveBase, name: 'googleDrive' as const }

    const store = createCloudStore({
      providers: ['memory', 'googleDrive'],
      writeMode: 'mirror',
    })
    store.registerProvider(apple)
    store.registerProvider(drive)

    await expect(store.setItem('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
    })
  })

  it('mirror deletes from every provider, so a copy cannot resurrect', async () => {
    const { apple, driveBase, drive } = twoProviders()
    const store = createCloudStore({
      providers: ['memory', 'googleDrive'],
      writeMode: 'mirror',
    })
    store.registerProvider(apple)
    store.registerProvider(drive)

    await store.setItem('k', 'v')
    await store.removeItem('k')

    expect(apple.dump()).toEqual({})
    expect(driveBase.dump()).toEqual({})
    // And a read must not find it via fallthrough.
    await expect(store.getItem('k')).resolves.toBeNull()
  })
})

describe('deleting when nothing is reachable', () => {
  const offline = (p: MemoryProvider, name: 'memory' | 'googleDrive') => ({
    ...p,
    name,
    isAvailable: () => Promise.resolve(false),
  })

  it('mirror rejects rather than reporting a delete that happened nowhere', async () => {
    // The false success this package exists to avoid, in the one place it
    // survived: with no provider available there was nothing to delete from,
    // and `removeItem` resolved anyway.
    const mem = createMemoryProvider({ initial: { k: 'v' } })
    const store = createCloudStore({ providers: ['memory'], writeMode: 'mirror' })
    store.registerProvider(offline(mem, 'memory'))

    await expect(store.removeItem('k')).rejects.toMatchObject({
      code: ErrorCode.NOT_SIGNED_IN,
    })
    // And the value is demonstrably still there, which is what makes the old
    // resolved promise a lie rather than a harmless one.
    expect(mem.dump()).toEqual({ k: 'v' })
  })

  it('failover already rejected, and still does', async () => {
    const mem = createMemoryProvider({ initial: { k: 'v' } })
    const store = createCloudStore({ providers: ['memory'] })
    store.registerProvider(offline(mem, 'memory'))

    await expect(store.removeItem('k')).rejects.toMatchObject({
      code: ErrorCode.NOT_SIGNED_IN,
    })
  })
})

describe('outbox does not accumulate poison entries', () => {
  it('drops a queued write that starts failing for a reason the user must act on', async () => {
    // A write is only ever queued for a retryable reason. If the retry then
    // hits quota, re-queueing it would retry forever, never drain, and never
    // tell anyone - so it is reported and dropped, matching what setItem does
    // with the same failure.
    const errors: string[] = []
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = setup(mem, { onError: (e: { code: string }) => errors.push(e.code) })

    await store.setItem('k', 'v')
    expect(store.pendingWrites()).toHaveLength(1)

    // The account filled up while the write sat in the queue.
    mem.setFault('setItem', { code: ErrorCode.QUOTA_EXCEEDED })
    const result = await store.flushOutbox()

    expect(result).toEqual({ drained: 0, remaining: 0 })
    expect(store.pendingWrites()).toHaveLength(0)
    expect(errors).toContain(ErrorCode.QUOTA_EXCEEDED)
  })

  it('still keeps a queued write that fails for a retryable reason', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = setup(mem)

    await store.setItem('k', 'v')
    const result = await store.flushOutbox()

    expect(result).toEqual({ drained: 0, remaining: 1 })
  })
})

describe('tiering', () => {
  const big = (bytes: number) => 'x'.repeat(bytes)

  function tiered(extra: Record<string, unknown>) {
    const kv = { ...createMemoryProvider(), name: 'icloudKV' as const }
    const ckBase = createMemoryProvider()
    const ck = { ...ckBase, name: 'cloudKit' as const }
    const driveBase = createMemoryProvider()
    const drive = { ...driveBase, name: 'googleDrive' as const }
    const store = createCloudStore({
      tiering: { kvMaxBytes: 64, recordMaxBytes: 128 },
      ...extra,
    } as Parameters<typeof createCloudStore>[0])
    store.registerProvider(kv)
    store.registerProvider(ck)
    store.registerProvider(drive)
    return { store, ckBase, driveBase }
  }

  it('honours recordMaxBytes, which used to be documented but never read', async () => {
    // A value between recordMaxBytes and CloudKit's hard 1 MB limit was routed
    // to CloudKit regardless, so the threshold did nothing at all.
    const { store, ckBase, driveBase } = tiered({
      providers: ['cloudKit', 'googleDrive'],
    })

    await store.setItem('k', big(200))

    expect(ckBase.dump()).toEqual({})
    expect(driveBase.dump()).toEqual({ k: big(200) })
  })

  it('still routes a small value to the preferred provider', async () => {
    const { store, ckBase, driveBase } = tiered({
      providers: ['cloudKit', 'googleDrive'],
    })

    await store.setItem('k', big(10))

    expect(ckBase.dump()).toEqual({ k: big(10) })
    expect(driveBase.dump()).toEqual({})
  })

  it('rejects when no configured provider is large enough', async () => {
    const { store } = tiered({ providers: ['icloudKV', 'cloudKit'] })

    await expect(store.setItem('k', big(500))).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      actualBytes: 500,
    })
  })

  it('mirror skips a provider the value does not fit in, per threshold', async () => {
    const { store, ckBase, driveBase } = tiered({
      providers: ['cloudKit', 'googleDrive'],
      writeMode: 'mirror',
    })

    await store.setItem('k', big(200))

    expect(ckBase.dump()).toEqual({})
    expect(driveBase.dump()).toEqual({ k: big(200) })
  })
})
