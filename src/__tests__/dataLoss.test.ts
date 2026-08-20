import { createCloudStore, type CloudStore, type OutboxStorage } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'
import type { DroppedWrite } from '../types'

/**
 * Regressions for the five ways this store could lose or corrupt data.
 *
 * Each one is a path where the failure is silent - the call resolves, the app
 * believes it succeeded, and the damage only shows up as "my backup vanished"
 * days later. That makes them exactly the cases a test suite has to hold down,
 * because nothing else will notice them.
 */

function makeStorage(): OutboxStorage & { raw: () => string | undefined } {
  const map = new Map<string, string>()
  return {
    getString: k => map.get(k),
    set: (k, v) => { map.set(k, v) },
    raw: () => map.get('rncs.outbox.v1'),
  }
}

function withProviders(
  providers: MemoryProvider[],
  extra: Record<string, unknown> = {}
): { store: CloudStore; storage: ReturnType<typeof makeStorage> } {
  const storage = makeStorage()
  const store = createCloudStore({
    providers: providers.map(p => p.name),
    outboxStorage: storage,
    // Every probe counts in these tests; memoising would mask a provider that
    // went away mid-test.
    availabilityTtlMs: 0,
    ...extra,
  })
  for (const p of providers) store.registerProvider(p)
  return { store, storage }
}

// ---------------------------------------------------------------------------
// 1. A read with nothing reachable is not an absent key
// ---------------------------------------------------------------------------

describe('reading when no provider is reachable', () => {
  it('rejects rather than resolving null, which reads as "no backup exists"', async () => {
    // The documented first-launch recipe branches on `null` by seeding empty
    // state. Returning `null` here means a signed-out user's real backup gets
    // overwritten on next write - the precise failure this package exists to
    // prevent, reached through its own facade.
    const mem = createMemoryProvider({ available: false, initial: { k: 'real-backup' } })
    const { store } = withProviders([mem])

    await expect(store.getItem('k')).rejects.toMatchObject({
      code: ErrorCode.NOT_SIGNED_IN,
    })
  })

  it('still resolves null when a provider IS reachable and genuinely lacks the key', async () => {
    const mem = createMemoryProvider()
    const { store } = withProviders([mem])
    await expect(store.getItem('missing')).resolves.toBeNull()
  })

  it('applies to a resolving read too, not only the fast path', async () => {
    const mem = createMemoryProvider({ available: false })
    const { store } = withProviders([mem], { resolve: () => null })

    await expect(store.getItem('k')).rejects.toMatchObject({
      code: ErrorCode.NOT_SIGNED_IN,
    })
  })

  it('answers from the providers that are up when only some are down', async () => {
    const down = createMemoryProvider({ name: 'down', available: false })
    const up = createMemoryProvider({ name: 'up', initial: { k: 'v' } })
    const { store } = withProviders([down, up])

    await expect(store.getItem('k')).resolves.toBe('v')
  })

  it('rejects a multiGet with nothing reachable, for the same reason', async () => {
    const mem = createMemoryProvider({ available: false })
    const { store } = withProviders([mem])

    await expect(store.multiGet(['a', 'b'])).rejects.toMatchObject({
      code: ErrorCode.NOT_SIGNED_IN,
    })
  })
})

// ---------------------------------------------------------------------------
// 2. mirror + tiering must not strand a stale copy
// ---------------------------------------------------------------------------

describe('a value that grows past a provider limit', () => {
  const tiering = { kvMaxBytes: 32, recordMaxBytes: 1024 }

  it('removes the stale small copy instead of leaving it to be read back', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({ name: 'googleDrive' })
    const { store } = withProviders([small, big], { writeMode: 'mirror', tiering })

    await store.setItem('k', 'short')
    expect(small.dump()).toEqual({ k: 'short' })

    // Now over icloudKV's 32-byte ceiling, so it is skipped as a destination.
    const long = 'x'.repeat(200)
    await store.setItem('k', long)

    expect(big.dump()).toEqual({ k: long })
    // The old copy must not survive: reads prefer this provider, so leaving it
    // there means `getItem` serves 'short' forever.
    expect(small.dump()).toEqual({})
    await expect(store.getItem('k')).resolves.toBe(long)
  })

  it('drops the old copy only once the new value has landed somewhere', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({
      name: 'googleDrive',
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([small, big], { writeMode: 'mirror', tiering })

    await store.setItem('k', 'short')
    await store.setItem('k', 'x'.repeat(200))

    // Nothing stored the new value, so the old one is still the best copy the
    // user has. Evicting it here would leave the key existing nowhere at all.
    expect(small.dump()).toEqual({ k: 'short' })
  })

  it('read repair removes a stale copy it cannot overwrite', async () => {
    const small = createMemoryProvider({ name: 'icloudKV', initial: { k: 'stale' } })
    const long = 'x'.repeat(200)
    const big = createMemoryProvider({ name: 'googleDrive', initial: { k: long } })

    const { store } = withProviders([small, big], {
      tiering,
      // Deterministically prefer the long value regardless of order.
      resolve: (candidates: { value: string }[]) =>
        candidates.map(c => c.value).sort((a, b) => b.length - a.length)[0],
    })

    await expect(store.getItem('k')).resolves.toBe(long)
    // Repair is fire-and-forget, so let the microtask queue settle.
    await new Promise(r => setTimeout(r, 0))

    expect(small.dump()).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 3. A queued write must not resurrect over a newer successful one
// ---------------------------------------------------------------------------

describe('a queued write superseded by a later successful one', () => {
  it('does not overwrite the newer value when the queue later drains', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 } },
    })
    const { store } = withProviders([mem])

    // Offline: v1 is queued.
    await store.setItem('k', 'v1')
    expect(store.pendingWrites()).toHaveLength(1)

    // Back online: v2 is written directly and succeeds.
    await store.setItem('k', 'v2')
    expect(mem.dump()).toEqual({ k: 'v2' })

    // The queued v1 is now stale and must have been dropped by the write that
    // superseded it. Draining it would silently revert the user's newer value.
    expect(store.pendingWrites()).toHaveLength(0)
    await store.flushOutbox()
    expect(mem.dump()).toEqual({ k: 'v2' })
  })

  it('a successful delete also clears the queued write for that key', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([mem])

    await store.setItem('k', 'v1')
    expect(store.pendingWrites()).toHaveLength(1)

    mem.setFault('setItem', null)
    await store.removeItem('k')

    // Otherwise the flush recreates a key the user just deleted.
    expect(store.pendingWrites()).toHaveLength(0)
    await store.flushOutbox()
    expect(mem.dump()).toEqual({})
  })

  it('multiSet clears queued entries for every key it wrote', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 2 } },
    })
    const { store } = withProviders([mem])

    await store.setItem('a', 'old')
    await store.setItem('b', 'old')
    expect(store.pendingWrites()).toHaveLength(2)

    await store.multiSet([['a', 'new'], ['b', 'new']])
    expect(store.pendingWrites()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Flushing must not lose or duplicate work
// ---------------------------------------------------------------------------

describe('flushOutbox concurrency', () => {
  it('keeps a write that was enqueued while the flush was in flight', async () => {
    // Two providers so the two halves of the race have different durations and
    // the interleaving is deterministic rather than a coin flip:
    //   `fast` fails instantly, so its enqueue lands early in the window;
    //   `slow` takes 50ms, so the flush is still awaiting when that happens.
    // Faults are scoped per key so neither operation consumes the other's.
    const fast = createMemoryProvider({
      name: 'fast',
      faults: {
        setItem: {
          code: ErrorCode.NETWORK_UNAVAILABLE,
          only: k => k === 'arrived-mid-flush',
        },
      },
    })
    const slow = createMemoryProvider({
      name: 'slow',
      latencyMs: 50,
      faults: {
        setItem: { code: ErrorCode.NETWORK_UNAVAILABLE, only: k => k === 'queued', times: 1 },
      },
    })
    const { store } = withProviders([fast, slow], { writeMode: 'mirror' })

    await store.setItem('queued', 'v')
    expect(store.pendingWrites().map(e => e.provider)).toEqual(['slow'])

    // The flush retries the slow provider, so it is mid-await for ~50ms.
    const flush = store.flushOutbox()
    await store.setItem('arrived-mid-flush', 'v')
    await flush

    // The flush snapshotted the queue before this entry existed. Writing the
    // snapshot back wholesale would have discarded it.
    expect(store.pendingWrites().map(e => e.key)).toEqual(['arrived-mid-flush'])
  })

  it('two concurrent flushes send each entry once, not twice', async () => {
    const mem = createMemoryProvider({ latencyMs: 5 })
    const { store } = withProviders([mem])

    mem.setFault('setItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 1 })
    await store.setItem('k', 'v')
    mem.setFault('setItem', null)

    const before = mem.calls.setItem
    const [a, b] = await Promise.all([store.flushOutbox(), store.flushOutbox()])

    expect(mem.calls.setItem).toBe(before + 1)
    // The second caller joins the in-flight flush rather than starting its own.
    expect(a).toEqual(b)
  })
})

describe('the outbox does not grow without limit', () => {
  it('drops the oldest entry when the cap is reached, and says so', async () => {
    const dropped: DroppedWrite[] = []
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([mem], {
      outboxMaxEntries: 2,
      onDropped: (d: DroppedWrite) => dropped.push(d),
    })

    await store.setItem('a', '1')
    await store.setItem('b', '2')
    await store.setItem('c', '3')

    expect(store.pendingWrites().map(e => e.key)).toEqual(['b', 'c'])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ reason: 'queueFull', entry: { key: 'a' } })
  })

  it('gives up on an entry that has failed too many times', async () => {
    const dropped: DroppedWrite[] = []
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([mem], {
      outboxMaxAttempts: 2,
      onDropped: (d: DroppedWrite) => dropped.push(d),
    })

    await store.setItem('k', 'v')
    // First flush: attempt 1, still under the cap, so it is kept with a backoff.
    await store.flushOutbox()
    // Force the backoff to have elapsed rather than waiting it out.
    const [entry] = store.pendingWrites()
    expect(entry.attempts).toBe(1)

    jest.spyOn(Date, 'now').mockReturnValue(entry.nextAttemptAt + 1)
    try {
      const result = await store.flushOutbox()
      expect(result.dropped).toHaveLength(1)
      expect(result.dropped[0].reason).toBe('tooManyAttempts')
    }
    finally {
      jest.spyOn(Date, 'now').mockRestore()
    }

    expect(store.pendingWrites()).toHaveLength(0)
    expect(dropped.map(d => d.reason)).toContain('tooManyAttempts')
  })

  it('lets the app abandon a stuck write itself', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([mem])

    await store.setItem('a', '1')
    await store.setItem('b', '2')

    expect(store.discardPendingWrites(e => e.key === 'a')).toBe(1)
    expect(store.pendingWrites().map(e => e.key)).toEqual(['b'])

    expect(store.discardPendingWrites()).toBe(1)
    expect(store.pendingWrites()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. An account switch must not carry state across users
// ---------------------------------------------------------------------------

describe('when a different account signs in', () => {
  it('abandons queued writes, which belong to the account that just left', async () => {
    const dropped: DroppedWrite[] = []
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([mem], {
      onDropped: (d: DroppedWrite) => dropped.push(d),
    })

    // Subscribing is what wires the store to provider events.
    store.onAccountChange(() => undefined)

    await store.setItem('secret', 'user-a-data')
    expect(store.pendingWrites()).toHaveLength(1)

    mem.emitAccountChange({ status: 'available', identityChanged: true })

    // Flushing after the switch would write user A's data into user B's account.
    expect(store.pendingWrites()).toHaveLength(0)
    expect(dropped.map(d => d.reason)).toEqual(['accountChanged'])
  })

  it('tells every provider to drop what it cached for the previous user', () => {
    const mem = createMemoryProvider()
    const { store } = withProviders([mem])
    store.onAccountChange(() => undefined)

    expect(mem.cacheClears).toBe(0)
    mem.emitAccountChange({ status: 'available', identityChanged: true })
    expect(mem.cacheClears).toBe(1)
  })

  it('leaves the queue alone when the same account merely became available', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const { store } = withProviders([mem])
    store.onAccountChange(() => undefined)

    await store.setItem('k', 'v')
    mem.emitAccountChange({ status: 'available', identityChanged: false })

    // Coming back online is the case the outbox exists for. Dropping here would
    // discard exactly the writes it was holding for this moment.
    expect(store.pendingWrites()).toHaveLength(1)
    expect(mem.cacheClears).toBe(0)
  })

  it('forwards the event to app listeners as well as acting on it', () => {
    const mem = createMemoryProvider()
    const { store } = withProviders([mem])

    const seen: boolean[] = []
    store.onAccountChange(e => seen.push(e.identityChanged))

    mem.emitAccountChange({ status: 'available', identityChanged: true })
    expect(seen).toEqual([true])
  })
})
