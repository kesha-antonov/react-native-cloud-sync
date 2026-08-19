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

## Read fallthrough

`getItem` tries each provider in order and returns the first value it finds. That matters on a mixed fleet: a value written from an iPhone through `icloudKV` is still found on Android, where only `googleDrive` is available - without the app branching on platform.

`getAllKeys()` unions across providers, and a provider that cannot list does not hide the ones that can.

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

If a value is too large for the key-value store and no larger-capacity provider is configured, the write rejects with `ERR_PAYLOAD_TOO_LARGE` naming the fix, rather than failing somewhere in the OS.

Binary assets are **not** part of tiering - they are an explicit API, because you pass a file path rather than a string. See [CloudKit assets](providers/cloudkit.md#assets).

## The outbox

A write that fails for a **retryable** reason - offline, rate limited, account temporarily unavailable - is queued and retried with exponential backoff, honouring `retryAfterMs` when the server supplies one.

A write that fails for a reason **the user must act on** - signed out, quota exceeded - is *not* queued. It rejects immediately, because retrying it forever would only hide it.

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
