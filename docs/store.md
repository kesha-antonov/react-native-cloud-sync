# The store facade

One API over several providers, adding size tiering, a durable outbox, read fallthrough and migration.

Use it when you do not want the app to care which cloud a value lives in. Use the providers directly when you do.

```ts
import { createCloudStore } from '@kesha-antonov/react-native-cloud-sync'

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

**It does not give you cross-platform sync.** If that iPhone only ever wrote to iCloud, an Android device has nothing to read: iCloud is unreachable there, and Drive was never written to. For that you need `mirror`, or you need the user on Drive.

### `mirror` - the same data in more than one place

```ts
createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
})
```

Every write goes to every available provider. Now the iPhone writes to iCloud *and* Drive, and Android - which can only see Drive - finds the data.

Costs one request per provider per write, and requires the user to have connected each one.

**Partial failure is a success.** If one destination stores the value and another is offline, the write resolves and the failed one goes to the [outbox](#the-outbox) to be retried on its own. One good copy plus a queued retry is a better outcome than rejecting a write the user has already been told about. It rejects only when *nothing* stored it.

**Deletes mirror too.** Removing from only the preferred provider would leave a copy that reads then fall through to, resurrecting deleted data.

**Values too large for a provider are skipped, not fatal.** A 200 KB value goes to Drive and skips the iCloud key-value store rather than failing the whole write. If it fits nowhere, that rejects with `ERR_PAYLOAD_TOO_LARGE`.

### Read fallthrough

In both modes `getItem` tries each available provider in order and returns the first value found. `getAllKeys()` unions across providers, and a provider that cannot list does not hide the ones that can.

**First found is not newest.** That distinction does not matter while only one population of devices writes, and matters enormously as soon as both do - see below.

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
import { createCloudStore, resolveByTimestamp } from '@kesha-antonov/react-native-cloud-sync'

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
  resolve: resolveByTimestamp('updatedAt'),
})
```

`resolveByTimestamp` covers the usual shape - JSON values carrying a timestamp field, newest wins. It accepts epoch millis or ISO strings, prefers a value it can date over one it cannot, and keeps the earlier provider on a tie so results do not flap.

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
| ≤ 64 KB | iCloud key-value store |
| larger | the first record-capable provider in your list (`cloudKit` or `googleDrive`) |

Thresholds are configurable:

```ts
import { DEFAULT_TIERING } from '@kesha-antonov/react-native-cloud-sync'

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
const { drained, remaining } = await store.flushOutbox()
```

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

Any store with `getString`/`set` works - AsyncStorage wrapped in the same two methods is fine.

### Surfacing it

```ts
const pending = store.pendingWrites()
// [{ key, value, provider, attempts, nextAttemptAt, enqueuedAt }]

if (pending.length > 0) showPendingBadge(pending.length)
```

## Migration

```ts
const { copied } = await store.migrate({ from: 'icloudKV', to: 'googleDrive' })
```

Copies every key from one provider to the other. The source is **left intact** - this is a copy, not a move, so a failed migration cannot lose data. Delete the source afterwards yourself if you mean to.

## Registering another provider

```ts
import { createMemoryProvider } from '@kesha-antonov/react-native-cloud-sync/testing'

const fake = createMemoryProvider()
store.registerProvider(fake)
```

Used for the in-memory double in tests, and for any provider you implement yourself against the `CloudProvider` interface.
