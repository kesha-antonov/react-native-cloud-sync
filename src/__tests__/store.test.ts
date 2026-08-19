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
