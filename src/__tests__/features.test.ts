import { createCloudStore, type CloudStore, type OutboxStorage } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'
import { checkKey, sanitizeKey } from '../internal/keys'
import { resolveByModifiedAt, resolveByTimestamp, resolveFirstOf } from '../resolvers'
import { byteLength } from '../internal/bytes'
import { withTimeout } from '../internal/timeout'
import type { RemoteChangeEvent, ResolveCandidate } from '../types'

function makeStorage(): OutboxStorage {
  const map = new Map<string, string>()
  return {
    getString: k => map.get(k),
    set: (k, v) => { map.set(k, v) },
  }
}

function withProviders(
  providers: MemoryProvider[],
  extra: Record<string, unknown> = {}
): CloudStore {
  const store = createCloudStore({
    providers: providers.map(p => p.name),
    outboxStorage: makeStorage(),
    availabilityTtlMs: 0,
    ...extra,
  })
  for (const p of providers) store.registerProvider(p)
  return store
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

describe('batch operations', () => {
  it('multiGet reads every key in one provider call, not one per key', async () => {
    const mem = createMemoryProvider({ initial: { a: '1', b: '2', c: '3' } })
    const store = withProviders([mem])

    const before = mem.calls.getItem
    await expect(store.multiGet(['a', 'b', 'c'])).resolves.toEqual([
      ['a', '1'], ['b', '2'], ['c', '3'],
    ])

    // The whole point: CloudKit's /records/lookup takes an array, so a loop
    // here would be three round trips and three chances to be throttled.
    expect(mem.calls.getItem).toBe(before + 1)
  })

  it('multiGet reports a missing key as null rather than omitting it', async () => {
    const mem = createMemoryProvider({ initial: { a: '1' } })
    const store = withProviders([mem])

    // Positional, so the caller can zip the result against their input.
    await expect(store.multiGet(['a', 'gone'])).resolves.toEqual([['a', '1'], ['gone', null]])
  })

  it('multiGet only asks a later provider for the keys still missing', async () => {
    const first = createMemoryProvider({ name: 'first', initial: { a: '1' } })
    const second = createMemoryProvider({ name: 'second', initial: { b: '2' } })
    const store = withProviders([first, second])

    await expect(store.multiGet(['a', 'b'])).resolves.toEqual([['a', '1'], ['b', '2']])
  })

  it('multiSet writes in one provider call', async () => {
    const mem = createMemoryProvider()
    const store = withProviders([mem])

    const before = mem.calls.setItem
    await store.multiSet([['a', '1'], ['b', '2']])

    expect(mem.dump()).toEqual({ a: '1', b: '2' })
    expect(mem.calls.setItem).toBe(before + 1)
  })

  it('multiSet splits a batch across providers when tiering routes values differently', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([small, big], { tiering: { kvMaxBytes: 16, recordMaxBytes: 1024 } })

    const long = 'x'.repeat(64)
    await store.multiSet([['tiny', 'v'], ['huge', long]])

    // One batch would have sent both to the preferred provider and failed the
    // oversized one at the server.
    expect(small.dump()).toEqual({ tiny: 'v' })
    expect(big.dump()).toEqual({ huge: long })
  })

  it('multiRemove deletes in one call', async () => {
    const mem = createMemoryProvider({ initial: { a: '1', b: '2', c: '3' } })
    const store = withProviders([mem])

    const before = mem.calls.removeItem
    await store.multiRemove(['a', 'b'])

    expect(mem.dump()).toEqual({ c: '3' })
    expect(mem.calls.removeItem).toBe(before + 1)
  })

  it('clear enumerates rather than requiring a hardcoded key list', async () => {
    const mem = createMemoryProvider({ initial: { a: '1', b: '2' } })
    const store = withProviders([mem])

    // A "delete my data" flow that forgets a key has not deleted the user's
    // data - so this has to come from getAllKeys, not from the caller.
    const { removed } = await store.clear()
    expect(removed.sort()).toEqual(['a', 'b'])
    expect(mem.dump()).toEqual({})
  })

  it('empty batches do no work and do not reject', async () => {
    const mem = createMemoryProvider({ available: false })
    const store = withProviders([mem])

    await expect(store.multiGet([])).resolves.toEqual([])
    await expect(store.multiSet([])).resolves.toBeUndefined()
    await expect(store.multiRemove([])).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

describe('key rules', () => {
  it('accepts the alphabet every provider agrees on', () => {
    expect(checkKey('settings.theme_v2-1', ['icloudKV', 'cloudKit', 'googleDrive'])).toBeNull()
  })

  it('rejects characters CloudKit record names cannot carry', () => {
    // Would come back as BAD_REQUEST -> ERR_CONTAINER_MISCONFIGURED, sending
    // the developer to look at their entitlements instead of at their key.
    expect(checkKey('settings/theme', ['cloudKit'])?.reason).toMatch(/ASCII letters/)
    expect(checkKey('café', ['cloudKit'])).not.toBeNull()
    expect(checkKey('', ['cloudKit'])).not.toBeNull()
  })

  it('rejects the underscore prefix CloudKit reserves', () => {
    expect(checkKey('_internal', ['cloudKit'])?.reason).toMatch(/reserves/)
  })

  it('applies the 64-byte key-value ceiling only when icloudKV is configured', () => {
    const long = 'k'.repeat(100)
    expect(checkKey(long, ['icloudKV'])?.provider).toBe('icloudKV')
    // Rejecting this for a Drive-only app would be a false alarm.
    expect(checkKey(long, ['googleDrive'])).toBeNull()
  })

  it('measures that ceiling in UTF-8 bytes, which is what Apple documents', () => {
    // 40 characters, but well over 64 bytes once encoded.
    const key = 'a'.repeat(40)
    expect(byteLength(key)).toBe(40)
    expect(checkKey(key, ['icloudKV'])).toBeNull()
  })

  it('the store rejects a bad key before making a request', async () => {
    const mem = createMemoryProvider({ name: 'cloudKit' })
    const store = withProviders([mem])

    await expect(store.setItem('bad/key', 'v')).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
    expect(mem.calls.setItem).toBe(0)
  })

  it('can be turned off for a store that knows its keys are fine', async () => {
    const mem = createMemoryProvider({ name: 'cloudKit' })
    const store = withProviders([mem], { validateKeys: false })

    await expect(store.setItem('bad/key', 'v')).resolves.toBeUndefined()
  })
})

describe('sanitizeKey', () => {
  it('rewrites an arbitrary string into a usable key', () => {
    expect(checkKey(sanitizeKey('My Report (2024).pdf'), ['icloudKV', 'cloudKit'])).toBeNull()
  })

  it('strips the reserved prefix', () => {
    expect(sanitizeKey('__internal').startsWith('_')).toBe(false)
  })

  it('keeps two long keys distinct instead of truncating them together', () => {
    const a = sanitizeKey(`${'x'.repeat(80)}-alpha`)
    const b = sanitizeKey(`${'x'.repeat(80)}-beta`)

    // Truncation alone would map both onto the same key and silently merge two
    // unrelated values.
    expect(a).not.toBe(b)
    expect(checkKey(a, ['icloudKV'])).toBeNull()
    expect(checkKey(b, ['icloudKV'])).toBeNull()
  })

  it('never produces an empty key', () => {
    expect(sanitizeKey('///')).not.toBe('')
    expect(checkKey(sanitizeKey('///'), ['cloudKit'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

describe('value codec', () => {
  // Not a real cipher - just something that proves the value is transformed on
  // the way out and restored on the way in.
  const codec = {
    encode: (value: string) => `enc:${value}`,
    decode: (value: string) => value.replace(/^enc:/, ''),
  }

  it('stores the encoded form and returns the decoded one', async () => {
    const mem = createMemoryProvider()
    const store = withProviders([mem], { codec })

    await store.setItem('k', 'secret')

    // What Drive would actually hold: appDataFolder is plaintext to anything
    // with the account's OAuth token, which is the gap this closes.
    expect(mem.dump()).toEqual({ k: 'enc:secret' })
    await expect(store.getItem('k')).resolves.toBe('secret')
  })

  it('decodes before the resolver sees a candidate', async () => {
    const a = createMemoryProvider({ name: 'a', initial: { k: 'enc:{"updatedAt":1}' } })
    const b = createMemoryProvider({ name: 'b', initial: { k: 'enc:{"updatedAt":2}' } })
    const store = withProviders([a, b], { codec, resolve: resolveByTimestamp('updatedAt') })

    // A resolver reads the app's values, so it has to run on plaintext -
    // otherwise every candidate is opaque and the newest cannot be picked.
    await expect(store.getItem('k')).resolves.toBe('{"updatedAt":2}')
  })

  it('re-encodes on read repair', async () => {
    const a = createMemoryProvider({ name: 'a', initial: { k: 'enc:{"updatedAt":1}' } })
    const b = createMemoryProvider({ name: 'b', initial: { k: 'enc:{"updatedAt":2}' } })
    const store = withProviders([a, b], { codec, resolve: resolveByTimestamp('updatedAt') })

    await store.getItem('k')
    await new Promise(r => setTimeout(r, 0))

    // Repairing with plaintext would leave one provider holding a value the
    // decoder cannot read back.
    expect(a.dump()).toEqual({ k: 'enc:{"updatedAt":2}' })
  })

  it('decodes through multiGet as well', async () => {
    const mem = createMemoryProvider()
    const store = withProviders([mem], { codec })

    await store.multiSet([['a', '1'], ['b', '2']])
    await expect(store.multiGet(['a', 'b'])).resolves.toEqual([['a', '1'], ['b', '2']])
  })
})

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

describe('resolveByModifiedAt', () => {
  const resolve = resolveByModifiedAt()

  it('picks the newest by server time, with no timestamp inside the value', () => {
    const candidates: ResolveCandidate[] = [
      { provider: 'a', value: 'old', modifiedAt: 1000 },
      { provider: 'b', value: 'new', modifiedAt: 2000 },
    ]
    // The point of this resolver: it works on payloads the app never
    // instrumented, including plain strings.
    expect(resolve(candidates)).toBe('new')
  })

  it('keeps the earlier provider on a tie, so results do not flap', () => {
    expect(resolve([
      { provider: 'a', value: 'A', modifiedAt: 5 },
      { provider: 'b', value: 'B', modifiedAt: 5 },
    ])).toBe('A')
  })

  it('ignores a candidate whose provider reports no time', () => {
    // icloudKV never reports one - it has no per-key timestamp at all.
    expect(resolve([
      { provider: 'icloudKV', value: 'undated' },
      { provider: 'googleDrive', value: 'dated', modifiedAt: 1 },
    ])).toBe('dated')
  })

  it('falls back to preference order when nothing is dated', () => {
    expect(resolve([
      { provider: 'icloudKV', value: 'first' },
      { provider: 'other', value: 'second' },
    ])).toBe('first')
  })

  it('takes a custom fallback for the all-undated case', () => {
    const withEmbedded = resolveByModifiedAt({ fallback: resolveByTimestamp('updatedAt') })
    expect(withEmbedded([
      { provider: 'a', value: '{"updatedAt":1}' },
      { provider: 'b', value: '{"updatedAt":9}' },
    ])).toBe('{"updatedAt":9}')
  })
})

describe('resolveFirstOf', () => {
  it('uses server time where there is one and an embedded timestamp otherwise', () => {
    const resolve = resolveFirstOf(resolveByModifiedAt(), resolveByTimestamp('updatedAt'))

    expect(resolve([
      { provider: 'a', value: 'x', modifiedAt: 1 },
      { provider: 'b', value: 'y', modifiedAt: 2 },
    ])).toBe('y')
  })

  it('returns null when every resolver declines', () => {
    expect(resolveFirstOf(() => null, () => null)([])).toBeNull()
  })
})

describe('the store reads server metadata when a provider reports it', () => {
  it('passes modifiedAt through to the resolver', async () => {
    const older = createMemoryProvider({ name: 'older' })
    const newer = createMemoryProvider({ name: 'newer' })

    await older.setItem('k', 'old')
    await new Promise(r => setTimeout(r, 5))
    await newer.setItem('k', 'new')

    const store = withProviders([older, newer], { resolve: resolveByModifiedAt() })
    await expect(store.getItem('k')).resolves.toBe('new')
  })
})

// ---------------------------------------------------------------------------
// Quota, migration, events, timeouts
// ---------------------------------------------------------------------------

describe('getQuota', () => {
  it('reports each provider that knows, and skips those that do not', async () => {
    const knows = createMemoryProvider({
      name: 'knows',
      quota: { usedBytes: 100, totalBytes: 1000 },
    })
    const doesNot = createMemoryProvider({ name: 'doesNot' })
    const store = withProviders([knows, doesNot])

    await expect(store.getQuota()).resolves.toEqual([
      { usedBytes: 100, totalBytes: 1000, provider: 'knows' },
    ])
  })
})

describe('migrate', () => {
  it('reports what it copied, what was empty, and what failed', async () => {
    const from = createMemoryProvider({
      name: 'from',
      initial: { a: '1', bad: '2', c: '3' },
    })
    const to = createMemoryProvider({
      name: 'to',
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED, only: k => k === 'bad' } },
    })
    const store = withProviders([from, to])

    const result = await store.migrate({ from: 'from', to: 'to' })

    // Aborting on the first bad key would leave the user half migrated with no
    // record of how far it got.
    expect(result.copied.sort()).toEqual(['a', 'c'])
    expect(result.failed.map(f => f.key)).toEqual(['bad'])
    expect(to.dump()).toEqual({ a: '1', c: '3' })
  })

  it('can be told to stop at the first failure instead', async () => {
    const from = createMemoryProvider({ name: 'from', initial: { a: '1', b: '2' } })
    const to = createMemoryProvider({
      name: 'to',
      faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
    })
    const store = withProviders([from, to])

    const result = await store.migrate({ from: 'from', to: 'to', continueOnError: false })
    expect(result.copied).toEqual([])
    expect(result.failed).toHaveLength(1)
  })

  it('honours a filter and reports progress', async () => {
    const from = createMemoryProvider({ name: 'from', initial: { keep: '1', skip: '2' } })
    const to = createMemoryProvider({ name: 'to' })
    const store = withProviders([from, to])

    const seen: number[] = []
    const result = await store.migrate({
      from: 'from',
      to: 'to',
      filter: k => k === 'keep',
      onProgress: done => seen.push(done),
    })

    expect(result.copied).toEqual(['keep'])
    expect(seen).toEqual([1])
    expect(to.dump()).toEqual({ keep: '1' })
  })
})

describe('events on the facade', () => {
  it('merges remote-change events from every configured provider', () => {
    const a = createMemoryProvider({ name: 'a' })
    const b = createMemoryProvider({ name: 'b' })
    const store = withProviders([a, b])

    const seen: RemoteChangeEvent[] = []
    store.onRemoteChange(e => seen.push(e))

    a.emitRemoteChange({ keys: ['x'] })
    b.emitRemoteChange({ keys: ['y'] })

    // Previously only the raw providers exposed this, so the recommended entry
    // point could not be subscribed to at all.
    expect(seen.map(e => e.provider)).toEqual(['a', 'b'])
    expect(seen.flatMap(e => e.keys)).toEqual(['x', 'y'])
  })

  it('stops delivering after unsubscribe, and after dispose', () => {
    const mem = createMemoryProvider()
    const store = withProviders([mem])

    const seen: RemoteChangeEvent[] = []
    const off = store.onRemoteChange(e => seen.push(e))

    mem.emitRemoteChange({ keys: ['a'] })
    off()
    mem.emitRemoteChange({ keys: ['b'] })

    store.onRemoteChange(e => seen.push(e))
    store.dispose()
    mem.emitRemoteChange({ keys: ['c'] })

    expect(seen.flatMap(e => e.keys)).toEqual(['a'])
  })
})

describe('timeouts', () => {
  it('rejects with a retryable ERR_TIMEOUT rather than hanging forever', async () => {
    const slow = new Promise(() => undefined)
    await expect(withTimeout(slow, 10, 'test')).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
      provider: 'test',
    })
  })

  it('passes a value through when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
  })

  it('the store queues a timed-out write instead of losing it', async () => {
    const mem = createMemoryProvider({ latencyMs: 100 })
    const store = withProviders([mem], { timeoutMs: 10 })

    await store.setItem('k', 'v')

    // A timeout says nothing about whether the operation is possible, so it is
    // retryable - which means the outbox holds it rather than dropping it.
    expect(store.pendingWrites().map(e => e.lastErrorCode)).toEqual([ErrorCode.TIMEOUT])
  })
})

describe('availability memoisation', () => {
  it('reuses one probe across a burst of operations', async () => {
    const mem = createMemoryProvider({ initial: { a: '1', b: '2' } })
    const store = createCloudStore({
      providers: ['memory'],
      outboxStorage: makeStorage(),
      availabilityTtlMs: 10_000,
    })
    store.registerProvider(mem)

    let probes = 0
    const original = mem.isAvailable
    mem.isAvailable = async () => {
      probes += 1
      return await original()
    }

    await store.getItem('a')
    await store.getItem('b')
    await store.getItem('a')

    // Unmemoised this was a bridge hop, or a getAccessToken call, before every
    // single operation.
    expect(probes).toBe(1)
  })
})

describe('the codec and tiering together', () => {
  // Which order these run in decides whether a value that only just fits gets
  // routed somewhere it no longer fits once encrypted.
  const inflating = {
    encode: (value: string) => `${'#'.repeat(40)}${value}`,
    decode: (value: string) => value.slice(40),
  }

  it('routes on the encoded size, because that is what gets stored', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const big = createMemoryProvider({ name: 'googleDrive' })
    const store = withProviders([small, big], {
      codec: inflating,
      tiering: { kvMaxBytes: 32, recordMaxBytes: 1024 },
    })

    // 10 plaintext bytes fits the 32-byte ceiling; 50 encrypted bytes does not.
    await store.setItem('k', '0123456789')

    expect(small.dump()).toEqual({})
    expect(Object.keys(big.dump())).toEqual(['k'])
    await expect(store.getItem('k')).resolves.toBe('0123456789')
  })

  it('rejects when the encoded value fits nowhere, naming the encoded size', async () => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const store = withProviders([small], {
      codec: inflating,
      tiering: { kvMaxBytes: 32, recordMaxBytes: 1024 },
    })

    await expect(store.setItem('k', '0123456789')).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      actualBytes: 50,
    })
  })
})

describe('key rules are scoped to the provider that imposes them', () => {
  // Taken from a real app (MagisteriaApp) that syncs only through the iCloud
  // key-value store. These keys have been in production for years; a validator
  // that rejected them would break the anonymous-user id that gates a user's
  // purchased content.
  const KV_ONLY_KEYS = ['auth/anonymousUserId/v1', 'tests/chosedBaseUri/v1']

  it('allows a slash when only the key-value store is configured', () => {
    // `NSUbiquitousKeyValueStore` keys are plain strings - Apple documents a
    // 64-byte ceiling and no character rules at all.
    for (const key of KV_ONLY_KEYS) expect(checkKey(key, ['icloudKV'])).toBeNull()
  })

  it('allows a slash for Drive-only too', () => {
    for (const key of KV_ONLY_KEYS) expect(checkKey(key, ['googleDrive'])).toBeNull()
  })

  it('still rejects it as soon as CloudKit is in the list', () => {
    // Now the key really does have to be a record name.
    for (const key of KV_ONLY_KEYS) {
      const broken = checkKey(key, ['icloudKV', 'cloudKit'])
      expect(broken?.provider).toBe('cloudKit')
    }
  })

  it('applies the charset rule for cloudKitEncrypted as well', () => {
    expect(checkKey('a/b', ['cloudKitEncrypted'])?.provider).toBe('cloudKitEncrypted')
  })

  it('names the provider responsible, so the message says what to change', () => {
    expect(checkKey('_x', ['cloudKit'])?.provider).toBe('cloudKit')
    expect(checkKey('k'.repeat(100), ['icloudKV'])?.provider).toBe('icloudKV')
  })

  it('still rejects an empty key everywhere, since nothing can store one', () => {
    expect(checkKey('', ['icloudKV'])).not.toBeNull()
    expect(checkKey('', ['googleDrive'])).not.toBeNull()
  })
})
