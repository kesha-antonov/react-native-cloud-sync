# The store facade

One API over several providers, adding size tiering, a durable outbox, read fallthrough and migration.

Use it when you do not want the app to care which cloud a value lives in. Use the providers directly when you do.

```ts
import { createCloudStore } from 'react-native-cloud-sync'

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],  // preference order
  tiering: 'auto',
  outbox: true,
  outboxStorage: mmkvAdapter,
  onError: e => report(e),
})
```

| Method | Behaviour |
|---|---|
| `getItem(key)` | Falls through the provider list until a value is found |
| `setItem(key, value)` | Writes to the first available provider, routed by size |
| `removeItem(key)` | Removes from the first available provider |
| `getAllKeys()` | Union across every available provider |
| `migrate({ from, to })` | Copies every key. The source is left intact |
| `flushOutbox()` | Retries queued writes that are due |
| `pendingWrites()` | Queued entries, for a "pending sync" indicator |
| `registerProvider(p)` | Adds a provider - e.g. the in-memory test double |

## How the provider list is used

This is the part worth reading carefully, because the obvious reading of `providers: ['icloudKV', 'googleDrive']` is "both", and by default it is not.

| | Default (`failover`) | `writeMode: 'mirror'` |
|---|---|---|
| `setItem` | first available provider **only** | **every** available provider |
| `removeItem` | first available provider only | every available provider |
| `getItem` | falls through the list | falls through the list |
| `getAllKeys` | union across all | union across all |

### `failover` - the providers are alternatives

```ts
createCloudStore({ providers: ['icloudKV', 'googleDrive'] })
```

On an iPhone with iCloud signed in, writes go to **iCloud only**. Drive is a read fallback, not a second destination.

Use this when the providers are alternatives - iCloud where it exists, Drive otherwise - and each device only needs to reach its own copy.

It does not give you cross-platform sync. If that iPhone only ever wrote to iCloud, an Android device has nothing to read: iCloud is unreachable there, and Drive was never written to. For that you need `mirror`, or you need the user on Drive.

### `mirror` - the same data in more than one place

```ts
createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
})
```

Every write goes to every available provider. Now the iPhone writes to iCloud *and* Drive, and Android - which can only see Drive - finds the data.

Costs one request per provider per write, and requires the user to have connected each one.

Partial failure counts as a success: if one destination stores the value and another is offline, the write resolves and the failed one goes to the [outbox](#the-outbox) to be retried on its own. One good copy plus a queued retry is a better outcome than rejecting a write the user has already been told about. It rejects only when *nothing* stored it.

Deletes mirror too - removing from only the preferred provider would leave a copy that reads then fall through to, resurrecting deleted data.

Values too large for a provider are skipped, not fatal: a 200 KB value goes to Drive and skips the iCloud key-value store rather than failing the whole write. If it fits nowhere, that rejects with `ERR_PAYLOAD_TOO_LARGE`.

### Read fallthrough

In both modes `getItem` tries each available provider in order and returns the first value found. `getAllKeys()` unions across providers, and a provider that cannot list does not hide the ones that can.

First found is not newest - that distinction does not matter while only one population of devices writes, and matters enormously as soon as both do. See below.

## Two-way sync across a mixed fleet

Mirroring gets a copy into every store. It does not, on its own, make reads correct when both sides write.

Consider an iPhone configured `['icloudKV', 'googleDrive']` with `mirror`, and an Android phone that can only reach Drive:

1. The iPhone writes. iCloud and Drive both hold `A`.
2. The Android phone writes. Drive now holds `B`; iCloud still holds `A`, because Android cannot reach it.
3. The iPhone reads. iCloud is first in the list and has a value, so it returns `A` - and never looks at Drive.

The iPhone serves stale data indefinitely. The direction that breaks is always *towards* the device that can reach the preferred store.

### `resolve`

The store holds opaque strings, so it cannot know which copy is newer - only your app knows what its values mean. Supply a resolver and a read consults **every** available provider, then asks you which wins:

```ts
import { createCloudStore, resolveByTimestamp } from 'react-native-cloud-sync'

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
  resolve: resolveByTimestamp('updatedAt'),
})
```

`resolveByTimestamp` covers the usual shape - JSON values carrying a timestamp field, newest wins. It accepts epoch millis or ISO strings, prefers a value it can date over one it cannot, and keeps the earlier provider on a tie so results do not flap.

Not every value should have one write clobber another, though. For a JSON array where two devices adding *different* elements should both survive - a list of favorited item ids, dismissed-tip ids - use `resolveByUnion` instead. It merges every candidate's array rather than picking one:

```ts
import { resolveByUnion } from 'react-native-cloud-sync'

resolve: resolveByUnion({ key: item => item.id })
```

Deletions do not propagate through a union - removing an element on one device does not remove it from the merged result, since a plain array carries no record of what used to be there. Track removals yourself (a separate `removedIds` set, synced the same way) if that matters.

Write your own for anything else:

```ts
resolve: (candidates) => {
  // candidates: [{ provider, value }, ...] in preference order
  return merge(candidates.map(c => JSON.parse(c.value)))
}
```

Returning `null` means "none of these", which reads as absent.

### Read repair

After resolving, the winner is written back to any provider that disagreed. That is what makes the two sides actually converge - without it the losing store keeps its old value and every read pays to resolve again, forever.

It is best-effort and never fails the read: the caller already has the right answer, and a failed repair only costs another resolution later. Disable with `repairOnRead: false`.

### The cost

A resolving read is one request per provider instead of one, and may issue repair writes. If a key is read on a hot path, either cache it or keep that key on a single provider.

Reads without a resolver are unchanged - first non-null, short-circuit.

## Tiering

Routes a write by size, so store limits stop leaking into product code.

| Payload | Backing store |
|---|---|
| ≤ 64 KB (`kvMaxBytes`) | iCloud key-value store |
| ≤ 900 KB (`recordMaxBytes`) | a CloudKit record field |
| larger | Google Drive, which stores whole files and has no cap of its own |

Each threshold caps one provider, and a value above a provider's cap is routed past it to the next one in your list that is both large enough and available. With `['icloudKV', 'cloudKit']` and nothing else, a 2 MB value fits nowhere and rejects.

Thresholds are configurable:

```ts
import { DEFAULT_TIERING } from 'react-native-cloud-sync'

createCloudStore({
  providers: ['icloudKV', 'cloudKit'],
  tiering: { kvMaxBytes: 32 * 1024, recordMaxBytes: 900 * 1024 },
})
```

`tiering: 'off'` always writes to the preferred provider.

If a value is too large for a provider and no larger-capacity provider is configured and available, the write rejects with `ERR_PAYLOAD_TOO_LARGE` naming the fix, rather than failing somewhere in the OS.

Binary assets are **not** part of tiering - they are an explicit API, because you pass a file path rather than a string. See [CloudKit assets](providers/cloudkit.md#assets).

## The outbox

A write that fails for a **retryable** reason - offline, rate limited, account temporarily unavailable - is queued and retried with exponential backoff, honouring `retryAfterMs` when the server supplies one.

A write that fails for a reason **the user must act on** - signed out, quota exceeded - is *not* queued. It rejects immediately, because retrying it forever would only hide it. The same rule applies on the way out: if a queued write later fails for one of those reasons, it is reported through `onError` and dropped rather than retried forever.

```ts
// On reconnect, or on app foreground:
const { drained, remaining, dropped } = await store.flushOutbox()
```

### Draining it automatically

A durable queue with no trigger is only half a feature. `autoFlush` wires the two moments nearly every app was calling `flushOutbox()` by hand:

```ts
createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  autoFlush: true,                       // foreground + a 60s timer
  // or: autoFlush: { onForeground: true, intervalMs: 30_000 }
})
```

Deliberately not network-aware. Detecting a reconnect needs `@react-native-community/netinfo`, and making every consumer install it to save one line in the ones that want it is a bad trade - so if you already have a NetInfo listener, call `flushOutbox()` from it as well. Foreground plus a slow timer covers the common case on its own, since an app that regained connectivity is nearly always about to be foregrounded.

### Giving up

The queue is bounded three ways, because an unbounded one is a slow leak - every enqueue rewrites the whole blob, so a long offline stretch degrades the write path itself.

| Option | Default | Meaning |
|---|---|---|
| `outboxMaxEntries` | 1000 | Oldest is evicted when full |
| `outboxMaxAttempts` | 12 | Roughly an hour of backoff |
| `outboxMaxAgeMs` | 7 days | Time matters independently of attempts |

Whenever an entry is abandoned it is reported, so the loss is visible rather than silent:

```ts
createCloudStore({
  providers: ['googleDrive'],
  onDropped: ({ entry, reason }) => {
    log(`gave up on ${entry.key}: ${reason}`)
  },
})
```

`reason` is one of `notRetryable`, `tooManyAttempts`, `expired`, `queueFull`, `accountChanged` or `discarded`.

The last one is yours to trigger - a UI that can show a stuck write should be able to let the user give up on it:

```ts
store.discardPendingWrites(e => e.key === stuck.key)
store.discardPendingWrites()               // all of them
```

`accountChanged` is the store acting on its own: see [account switches](#account-switches).

### Making it durable

The default outbox is **in-memory**, which means a queued write is lost if the app restarts before it drains. That defeats the point, so pass storage in production:

```ts
import { MMKV } from 'react-native-mmkv'

const mmkv = new MMKV()

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  outboxStorage: {
    getString: key => mmkv.getString(key),
    set: (key, value) => mmkv.set(key, value),
  },
})
```

**Both methods must be synchronous.** The outbox is read and written on the write path, so there is nowhere to await - an async store cannot be wrapped directly. MMKV is the recommendation: its reads and writes are synchronous, so a queued write is on disk before `setItem` returns and there is no window in which a crash loses it.

### Surfacing it

```ts
const pending = store.pendingWrites()
// [{ key, value, provider, attempts, nextAttemptAt, enqueuedAt }]

if (pending.length > 0) showPendingBadge(pending.length)
```

## Batch operations

```ts
const pairs = await store.multiGet(['a', 'b', 'c'])     // [['a', '1'], ['b', null], ...]
await store.multiSet([['a', '1'], ['b', '2']])
await store.multiRemove(['a', 'b'])
const all = await store.getAllItems()                   // { a: '1', b: '2' }
const { removed } = await store.clear()
```

These batch **per provider**, where the provider genuinely batches. CloudKit's `/records/lookup` and `/records/modify` both take arrays, so reading 200 keys is one request rather than 200 - which is also one rate-limit budget instead of 200 chances to be throttled. Drive stores one file per key and has no batch content endpoint, so the store loops there; same cost as writing the loop yourself, but it does not pretend otherwise.

`multiGet` results are positional, and a missing key comes back as `[key, null]` rather than being omitted, so you can zip them straight against your input.

`clear()` enumerates with `getAllKeys()` first, deliberately. A "delete my data" flow built on a hardcoded key list is a flow that will one day forget a key.

## Storage usage

```ts
for (const { provider, usedBytes, totalBytes } of await store.getQuota())
  if (totalBytes != null && usedBytes != null && usedBytes / totalBytes > 0.9)
    warnNearlyFull(provider)
```

Reported by the providers that know: Drive from `about.get`, and the iCloud key-value store against Apple's fixed 1 MB ceiling. CloudKit has no usage endpoint and reports nothing rather than a guess. `totalBytes` is absent on an unlimited account, which is not the same as zero - a "you are out of space" prompt that fires for someone with pooled Workspace storage is worse than no prompt.

## Migration

```ts
const { copied, skipped, failed } = await store.migrate({
  from: 'icloudKV',
  to: 'googleDrive',
  onProgress: (done, total) => setProgress(done / total),
})
```

Copies every key from one provider to the other. The source is **left intact** - this is a copy, not a move, so a failed migration cannot lose data. Delete the source afterwards yourself if you mean to.

It keeps going past a key that fails, and tells you which ones did:

| | |
|---|---|
| `copied` | Keys that made it |
| `skipped` | Present at the source but holding nothing |
| `failed` | `{ key, error }` for each one that did not |

Aborting on the first bad key would leave the user half migrated with no record of how far it got, which is the worst of both outcomes. Pass `continueOnError: false` if you would rather stop, and `filter` to migrate a subset.

## Account switches

Subscribe once and the store handles the dangerous part itself:

```ts
store.onAccountChange(({ identityChanged, status }) => {
  if (identityChanged) dropUserScopedCaches()
})
```

Events from every configured provider are merged here, and `onRemoteChange` works the same way - previously only the raw providers exposed these, so the facade could not be subscribed to at all.

Account events are deduplicated. On Apple platforms `icloudKV` and `cloudKit` both observe the same two system notifications and relabel them with their own name - correctly, since an Apple ID change matters to both - so without this a store configured with both would hand your listener one system event twice.

Note that `cloudKit` reports account changes but **not** remote data changes: `cloudKit.onRemoteChange` is `undefined` rather than a subscription that never fires. CloudKit tracks record changes with a server change token, which only works in a custom zone, or through a `CKDatabaseSubscription` delivered over APNs. `icloudKV` and `googleDrive` both report changes normally.

On `identityChanged: true` the store also, without being asked:

- drops its memoised availability answers;
- calls `clearCaches()` on every provider, which throws away memoised Drive file ids and CloudKit reachability - both recorded for whoever was signed in at the time;
- **abandons the outbox**, reporting each entry through `onDropped` with reason `accountChanged`.

That last one is the important one. A queued write carries no account identity, so flushing it after a switch would write the previous user's data into the new user's account.

Call `store.dispose()` when a store outlives its usefulness; it releases those subscriptions and stops auto-flush.

## Keys

One key string has to be an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Drive filename at once, and the three disagree about what is legal. The store checks before the request:

```ts
await store.setItem('settings/theme', 'dark')
// ERR_INVALID_KEY: a key may contain only ASCII letters, digits, and . _ -
```

Without that check this reaches CloudKit as `BAD_REQUEST`, maps to `ERR_CONTAINER_MISCONFIGURED`, and sends you to look at your entitlements.

Every rule is scoped to the provider that imposes it, and only checked when that provider is in your list:

| Rule | Applies when |
|---|---|
| Non-empty | always |
| ASCII letters, digits, `.`, `_`, `-` only | `cloudKit` / `cloudKitEncrypted` configured |
| No leading `_` | `cloudKit` / `cloudKitEncrypted` configured |
| At most 255 characters | `cloudKit` / `cloudKitEncrypted` configured |
| At most 64 **UTF-8 bytes** | `icloudKV` configured |

`settings/theme` is a fine key for a key-value-store-only app - those keys are plain strings with no character rules. It stops being fine the moment you add `cloudKit`, because it then has to be a record name as well. Scoping matters: a validator that applied CloudKit's alphabet everywhere would reject keys that had been working in production for years.

For keys you do not control - a filename, something the user typed:

```ts
import { sanitizeKey } from 'react-native-cloud-sync'

await store.setItem(sanitizeKey('My Report (2024).pdf'), json)
```

Over-long keys are truncated *and* suffixed with a hash of the original, because truncation alone maps every long key sharing a prefix onto the same short key and silently merges unrelated values.

Pass `validateKeys: false` to skip the check when your keys are known good.

## Encrypting at rest

Drive's `appDataFolder` is plaintext to anything holding the account's OAuth token. `codec` is the seam for closing that:

```ts
createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: (value, key) => encrypt(value, keyFor(key)),
    decode: (value, key) => decrypt(value, keyFor(key)),
  },
})
```

The package ships no crypto of its own on purpose - key management is your problem, and bundling a cipher would make it look solved. Bring one you chose.

Values only, never keys - `getAllKeys()`, tiering and read repair all need cleartext keys. Encoding runs *before* tiering picks a destination, so a value is routed by the size it will actually occupy; a codec that inflates its input makes your effective `kvMaxBytes` smaller than the number says. Decoding runs *before* a resolver sees a candidate, so resolvers still compare plaintext.

CloudKit has its own native end-to-end encryption that needs no key management at all - see [Encryption](encryption.md) for when to use which.

## Timeouts

```ts
createCloudStore({ providers: ['cloudKit'], timeoutMs: 15_000 })
```

React Native's `fetch` has no timeout and neither does CloudKit's native stack, so an unanswered socket hangs forever - including `isAvailable()`, which runs before every operation, so one hung probe stalls reads that would otherwise have fallen through to a working provider.

`ERR_TIMEOUT` is classified as retryable, because running out of time says nothing about whether the operation is possible. With the outbox on, a hung write is queued rather than lost.

The REST clients have their own independent defaults - 30s for CloudKit, 60s for Drive, where one "request" can be an 8 MiB chunk.

## Registering another provider

```ts
import { createMemoryProvider } from 'react-native-cloud-sync/testing'

const fake = createMemoryProvider()
store.registerProvider(fake)
```

Used for the in-memory double in tests, and for any provider you implement yourself against the `CloudProvider` interface.
