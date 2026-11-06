# The store facade

One API over several providers, with size tiering, a durable outbox, read fallthrough and migration. Use it when the app shouldn't care which cloud holds a value; use the providers directly when it should.

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
| `removeItem(key)` | Removes from every available provider |
| `getAllKeys()` | Union across every available provider |
| `migrate({ from, to })` | Copies every key. The source is left intact |
| `flushOutbox()` | Retries queued writes that are due |
| `pendingWrites()` | Queued entries, for a "pending sync" indicator |
| `registerProvider(p)` | Adds a provider - e.g. the in-memory test double |

## How the provider list is used

`providers: ['icloudKV', 'googleDrive']` does not mean "write to both" by default.

| | Default (`failover`) | `writeMode: 'mirror'` |
|---|---|---|
| `setItem` | first available provider **only** | **every** available provider |
| `removeItem` | every available provider | every available provider |
| `getItem` | falls through the list | falls through the list |
| `getAllKeys` | union across all | union across all |

### `failover` - the providers are alternatives

```ts
createCloudStore({ providers: ['icloudKV', 'googleDrive'] })
```

On an iPhone signed in to iCloud, writes go to **iCloud only**. Drive is a read fallback, not a second destination.

So there is no cross-platform sync: Android can't reach iCloud and Drive was never written. Use `mirror` for that, or put the user on Drive.

Deletes still go to every provider, because a write may have landed on a later one (the preferred one was down, or tiering routed past it). `removeItem` succeeds if any provider removed the key.

### `mirror` - the same data in more than one place

```ts
createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
})
```

Every write goes to every available provider, so the iPhone writes to iCloud and Drive, and Android finds the data on Drive.

- Costs one request per provider per write; the user must be connected to each.
- Partial failure counts as success: the failed destination queues in the [outbox](#the-outbox). The write rejects only when nothing stored it.
- Deletes go everywhere too.
- A provider too small for the value is skipped: a 200 KB value goes to Drive only. Fitting nowhere rejects with `ERR_PAYLOAD_TOO_LARGE`.

### Read fallthrough

In both modes `getItem` returns the first value found among available providers, in order. `getAllKeys()` unions across providers; one that can't list doesn't hide the others.

First found is not newest. See below.

## Two-way sync across a mixed fleet

Mirroring puts a copy in every store, but reads go wrong once both sides write. An iPhone with `['icloudKV', 'googleDrive']` and `mirror`, and an Android phone that only reaches Drive:

1. The iPhone writes. iCloud and Drive both hold `A`.
2. The Android phone writes. Drive now holds `B`; iCloud still holds `A`, because Android cannot reach it.
3. The iPhone reads. iCloud is first and has a value, so it returns `A` and never looks at Drive.

The iPhone serves stale data indefinitely.

### `resolve`

The store holds opaque strings, so only your app knows which copy is newer. With a resolver, a read consults **every** available provider and lets you pick the winner:

```ts
import { createCloudStore, resolveByTimestamp } from 'react-native-cloud-sync'

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
  resolve: resolveByTimestamp('updatedAt'),
})
```

`resolveByTimestamp`: JSON values with a timestamp field (epoch millis or ISO string), newest wins. A datable value beats an undatable one; ties keep the earlier provider, so results don't flap.

`resolveByUnion`: merges JSON arrays, so elements added on different devices (favorite ids, dismissed tips) all survive.

```ts
import { resolveByUnion } from 'react-native-cloud-sync'

resolve: resolveByUnion({ key: item => item.id })
```

Deletions don't propagate through a union. If that matters, track removals yourself (a `removedIds` set synced the same way).

Or write your own:

```ts
resolve: (candidates) => {
  // candidates: [{ provider, value }, ...] in preference order
  return merge(candidates.map(c => JSON.parse(c.value)))
}
```

Returning `null` reads as absent. All built-in resolvers are listed in the [API reference](API.md#resolvers).

### Read repair

After resolving, the winner is written back to every provider that disagreed, so later reads don't have to resolve again. Repair is best-effort and never fails the read. Disable with `repairOnRead: false`.

Repair counts a write queued in this device's [outbox](#the-outbox) as one more candidate. A queued write that loses is dropped (or the next flush would undo the repair); one that wins is left to the outbox; a queued delete is never undone.

With `resolve` set, `multiGet`, `getAllItems()` and [`useCloudItems`](hooks.md#useclouditems) resolve and repair each key as `getItem` does.

### The cost

A resolving read costs one request per provider instead of one, plus possible repair writes. Cache hot keys or keep them on a single provider.

For `multiGet`, a resolver that reads `modifiedAt` also needs server timestamps: free on CloudKit over REST, one listing per 50 keys on Drive, one `getItemWithMeta` per key on a provider without `multiGetWithMeta`. A custom resolver that ignores `modifiedAt` should set `usesModifiedAt = false` to keep one request per provider:

```ts
const byVersion: ResolveFn = candidates => pickHighestVersion(candidates)
byVersion.usesModifiedAt = false
```

Without a resolver, reads stop at the first non-null value.

## Tiering

Routes each write by size, so store limits stay out of product code.

| Payload | Backing store |
|---|---|
| up to 64 KB (`kvMaxBytes`) | iCloud key-value store |
| up to 900 KB (`recordMaxBytes`) | a CloudKit record field |
| larger | Google Drive (no cap) |

`recordMaxBytes` covers `cloudKitEncrypted` too. A value above a cap goes to the next provider in your list that is large enough and available. With only `['icloudKV', 'cloudKit']`, a 2 MB value fits nowhere and rejects.

When a value outgrows a provider, its old copy there is removed, so reads don't serve it.

```ts
import { DEFAULT_TIERING } from 'react-native-cloud-sync'

createCloudStore({
  providers: ['icloudKV', 'cloudKit'],
  tiering: { kvMaxBytes: 32 * 1024, recordMaxBytes: 900 * 1024 },
})
```

`tiering: 'off'` always writes to the preferred provider.

If no large-enough provider is available, the write rejects with `ERR_PAYLOAD_TOO_LARGE` before reaching the OS.

Binary assets are **not** tiered; they take a file path. See [CloudKit assets](providers/cloudkit.md#assets).

## The outbox

A write that fails for a **retryable** reason (offline, rate limited, account temporarily unavailable) is queued and retried with exponential backoff, honouring `retryAfterMs`.

A write that fails for a reason **the user must act on** (signed out, quota exceeded) is not queued; it rejects immediately. A queued write that later fails that way is reported through `onError` and dropped.

```ts
// On reconnect, or on app foreground:
const { drained, remaining, dropped } = await store.flushOutbox()
```

### Draining it automatically

`autoFlush` calls `flushOutbox()` on foreground and on a timer:

```ts
createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  autoFlush: true,                       // foreground + a 60s timer
  // or: autoFlush: { onForeground: true, intervalMs: 30_000 }
})
```

The timer only runs while the app is active. It is not network-aware, to avoid a `@react-native-community/netinfo` dependency; call `flushOutbox()` from your own NetInfo listener if you want reconnect flushes.

### Giving up

The queue is bounded three ways, since every enqueue rewrites the whole blob:

| Option | Default | Meaning |
|---|---|---|
| `outboxMaxEntries` | 1000 | Oldest is evicted when full |
| `outboxMaxAttempts` | 12 | About 23.5 minutes of backoff at minimum |
| `outboxMaxAgeMs` | 7 days | Time matters independently of attempts |

After the n-th failure the next retry waits 2^n seconds, capped at five minutes (or the server's `Retry-After`, clamped to 0 to 1 hour). That is a minimum: retries only run when a flush does, so wall-clock time is usually longer, bounded by `outboxMaxAgeMs`.

Every abandoned entry is reported:

```ts
createCloudStore({
  providers: ['googleDrive'],
  onDropped: ({ entry, reason }) => {
    log(`gave up on ${entry.key}: ${reason}`)
  },
})
```

`reason` is one of `notRetryable`, `tooManyAttempts`, `expired`, `queueFull`, `accountChanged` or `discarded`.

You trigger `discarded`, for example from a UI that lets the user give up on a stuck write:

```ts
store.discardPendingWrites(e => e.key === stuck.key)
store.discardPendingWrites()               // all of them
```

For `accountChanged`, see [account switches](#account-switches).

### Making it durable

The default outbox is **in-memory**: queued writes are lost if the app restarts first. Pass storage in production:

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

**Both methods must be synchronous**: the outbox runs on the write path with nowhere to await. MMKV puts a queued write on disk before `setItem` returns.

`cloudKitEncrypted` writes are queued in memory only, never in `outboxStorage`, because the value is plaintext until native code encrypts it. They are lost on restart but listed by `pendingWrites()`. Entries an older version persisted are moved to memory and removed from storage on startup.

### Ordering

Operations on the same key and provider run one at a time, so an older queued value can't land on top of a newer direct write. A flush skips entries removed while it waited (by a newer write, `discardPendingWrites` or an account switch).

With `timeoutMs`, a timed-out request releases the key while it may still be in flight.

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

These batch **per provider** where the backend supports it. CloudKit's `/records/lookup` and `/records/modify` take arrays, so 200 keys are one request. Drive has no batch endpoint, so the store loops.

`multiGet` results are positional; a missing key is `[key, null]`, not omitted.

`clear()` enumerates with `getAllKeys()` first, so it can't miss a key the way a hardcoded list can.

## Storage usage

```ts
for (const { provider, usedBytes, totalBytes } of await store.getQuota())
  if (totalBytes != null && usedBytes != null && usedBytes / totalBytes > 0.9)
    warnNearlyFull(provider)
```

Drive reports from `about.get`, the iCloud key-value store against Apple's fixed 1 MB limit. CloudKit has no usage endpoint and reports nothing. `totalBytes` absent means unlimited (for example pooled Workspace storage), not zero.

## Migration

```ts
const { copied, skipped, failed } = await store.migrate({
  from: 'icloudKV',
  to: 'googleDrive',
  onProgress: (done, total) => setProgress(done / total),
})
```

A copy, not a move: the source is **left intact**. Delete it yourself afterward if you mean to.

Failed keys don't stop the run:

| | |
|---|---|
| `copied` | Keys that made it |
| `skipped` | Present at the source but holding nothing |
| `failed` | `{ key, error }` for each one that did not |

Pass `continueOnError: false` to stop at the first failure, and `filter` to migrate a subset.

## Account switches

Subscribe once on the store:

```ts
store.onAccountChange(({ identityChanged, status }) => {
  if (identityChanged) dropUserScopedCaches()
})
```

Events from every configured provider merge here; `onRemoteChange` works the same way.

Account events are deduplicated: on Apple platforms `icloudKV` and `cloudKit` observe the same system notifications, so a store with both would otherwise deliver each event twice.

`cloudKit` reports account changes but **not** remote data changes: `cloudKit.onRemoteChange` is `undefined`. CloudKit change tracking needs a custom zone's change token or a `CKDatabaseSubscription` over APNs. `icloudKV` and `googleDrive` report changes normally.

On `identityChanged: true` the store:

- drops memoised availability;
- calls `clearCaches()` on every provider (Drive file ids, CloudKit reachability);
- **abandons the outbox**, reporting each entry through `onDropped` with reason `accountChanged`. A queued write carries no account identity, so flushing it would write the previous user's data into the new account.

`store.dispose()` releases the subscriptions and stops auto-flush.

## Keys

A key must work as an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Drive filename at once, and their rules differ. The store checks before the request:

```ts
await store.setItem('settings/theme', 'dark')
// ERR_INVALID_KEY: a key may contain only ASCII letters, digits, and . _ -
```

Without the check, CloudKit would answer `BAD_REQUEST`, mapped to a misleading `ERR_CONTAINER_MISCONFIGURED`.

Each rule applies only when its provider is in your list:

| Rule | Applies when |
|---|---|
| Non-empty | always |
| ASCII letters, digits, `.`, `_`, `-` only | `cloudKit` / `cloudKitEncrypted` configured |
| No leading `_` | `cloudKit` / `cloudKitEncrypted` configured |
| At most 255 characters | `cloudKit` / `cloudKitEncrypted` configured |
| At most 64 **UTF-8 bytes** | `icloudKV` configured |

`settings/theme` is fine with `icloudKV` alone, but not once `cloudKit` joins.

For keys you don't control (a filename, user input):

```ts
import { sanitizeKey } from 'react-native-cloud-sync'

await store.setItem(sanitizeKey('My Report (2024).pdf'), json)
```

A legal key comes back unchanged. Any other is cleaned, truncated if needed, and suffixed with `--` plus a 14-character hash of the original, so `a b` and `a-b`, or long keys sharing a prefix, stay distinct. `maxBytes` (default 64) below 16 throws a `RangeError`.

Pass `validateKeys: false` to skip the check when your keys are known good.

## Encrypting at rest

Drive's `appDataFolder` is plaintext to anyone holding the account's OAuth token. Encrypt values with `codec`:

```ts
createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: (value, key) => encrypt(value, keyFor(key)),
    decode: (value, key) => decrypt(value, keyFor(key)),
  },
})
```

- No cipher ships; bring your own and manage the keys.
- Values only, never keys (`getAllKeys()`, tiering and read repair need cleartext keys).
- Encoding runs before tiering, so an inflating codec shrinks your effective `kvMaxBytes`.
- Decoding runs before resolvers, so they compare plaintext.

CloudKit also has native end-to-end encryption with no key management. See [Encryption](encryption.md) for which to use.

## Timeouts

```ts
createCloudStore({ providers: ['cloudKit'], timeoutMs: 15_000 })
```

React Native's `fetch` and CloudKit's native stack have no timeout, so an unanswered socket hangs forever. That includes `isAvailable()`, which runs before every operation, so one hung probe stalls reads that could fall through to a working provider.

`ERR_TIMEOUT` is retryable; with the outbox on, a hung write is queued, not lost.

The REST clients have separate defaults: 30s for CloudKit, 60s for Drive (one request can be an 8 MiB chunk).

## Registering another provider

```ts
import { createMemoryProvider } from 'react-native-cloud-sync/testing'

const fake = createMemoryProvider()
store.registerProvider(fake)
```

For the in-memory test double, or your own provider implementing [`CloudProvider`](API.md#the-provider-contract).
