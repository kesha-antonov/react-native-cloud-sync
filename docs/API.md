# API Reference

Every operation rejects with a [`CloudSyncError`](#errors) on failure. `getItem` resolves `null` for exactly one condition: the key does not exist.

## Providers

All four providers implement `CloudProvider`:

```ts
interface CloudProvider {
  readonly name: ProviderName
  isAvailable: () => Promise<boolean>
  getAccountStatus: () => Promise<AccountStatus>
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  getAllKeys: () => Promise<string[]>
  onRemoteChange?: (cb: (e: RemoteChangeEvent) => void) => Unsubscribe
  onAccountChange?: (cb: (e: AccountChangeEvent) => void) => Unsubscribe
}
```

### `icloudKV`

`NSUbiquitousKeyValueStore`. Apple platforms only; rejects `ERR_UNSUPPORTED_PLATFORM` elsewhere.

Limits, enforced locally rather than left to fail server-side: **1 MB total**, **1 MB per key**, **1024 keys**.

```ts
import { icloudKV, icloudKVSync } from '@kesha-antonov/react-native-cloud-sync'

await icloudKV.setItem('settings/theme', 'dark')
await icloudKVSync() // schedules an upload; does NOT confirm one
```

### `cloudKit`

CloudKit private database. Native on iOS/macOS, REST on Android and web (requires `configureCloudKit`).

```ts
import { cloudKit, cloudKitZones } from '@kesha-antonov/react-native-cloud-sync'

await cloudKit.setItem('portfolio', json)

await cloudKitZones.create('MyZone')   // native only
await cloudKitZones.list()
await cloudKitZones.remove('MyZone')
```

Records are capped at **1 MB** excluding assets. Oversized writes reject locally with `ERR_PAYLOAD_TOO_LARGE`, carrying `limitBytes` and `actualBytes`.

### `googleDrive`

Drive `appDataFolder` - a hidden, per-app, per-account folder that survives app uninstall. Works identically on every platform. Requires `configureGoogleDrive`.

### `createMemoryProvider`

See [Testing](#testing).

## The facade

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],  // preference order
  tiering: 'auto' | 'off' | TieringConfig,
  outbox: true,
  outboxStorage: adapter,
  onError: (e) => report(e),
})
```

| Method | Behaviour |
|---|---|
| `getItem(key)` | Falls through the provider list until a value is found |
| `setItem(key, value)` | Writes to the first available provider, routed by size |
| `removeItem(key)` | Removes from the first available provider |
| `getAllKeys()` | Union across all available providers |
| `migrate({ from, to })` | Copies every key. The source is left intact |
| `flushOutbox()` | Retries queued writes that are due |
| `pendingWrites()` | Queued entries, for a "pending sync" indicator |
| `registerProvider(p)` | Adds a provider (e.g. the in-memory double) |

### Tiering

| Payload | Backing store |
|---|---|
| ≤ 64 KB | iCloud key-value store |
| ≤ 900 KB | CloudKit record field |
| larger | `CKAsset`, chunked |

Thresholds are configurable via `TieringConfig`. With `tiering: 'off'` values always go to the preferred provider.

### Outbox

A write that fails for a **retryable** reason (offline, rate limited, account temporarily unavailable) is queued and retried with exponential backoff, honouring `retryAfterMs` when the server supplies one.

A write that fails for a reason **the user must act on** (signed out, quota exceeded) is *not* queued - it rejects immediately, because retrying it forever would only hide it.

Pass `outboxStorage` backed by MMKV or AsyncStorage so the queue survives a restart. The default is in-memory.

## Errors

```ts
try {
  await store.setItem(key, value)
} catch (e) {
  e.code           // ErrorCode
  e.retryAfterMs   // on ERR_RATE_LIMITED
  e.limitBytes     // on ERR_PAYLOAD_TOO_LARGE
  e.actualBytes    // on ERR_PAYLOAD_TOO_LARGE
  e.serverValue    // on ERR_CONFLICT
  e.provider       // which provider raised it
}
```

| Code | Meaning |
|---|---|
| `ERR_NOT_SIGNED_IN` | No account signed in |
| `ERR_ACCOUNT_RESTRICTED` | Parental controls or MDM |
| `ERR_ACCOUNT_UNAVAILABLE` | `temporarilyUnavailable` - retry later |
| `ERR_ACCOUNT_UNDETERMINED` | Status could not be determined |
| `ERR_AUTH_EXPIRED` | Credential expired; re-auth needed |
| `ERR_NETWORK_UNAVAILABLE` | Offline or unreachable |
| `ERR_QUOTA_EXCEEDED` | Storage full |
| `ERR_RATE_LIMITED` | Backing off; see `retryAfterMs` |
| `ERR_PAYLOAD_TOO_LARGE` | Above the store's limit |
| `ERR_CONFLICT` | Concurrent write won; see `serverValue` |
| `ERR_CONTAINER_MISCONFIGURED` | Entitlement, container or token problem |
| `ERR_UNSUPPORTED_PLATFORM` | Provider not available here |
| `ERR_CANCELLED` | Cancelled by the caller |
| `ERR_UNKNOWN` | Unclassified; `cause` holds the original |

Helpers:

```ts
isCloudSyncError(e)   // shape-based guard, works on bridged plain objects
isRetryable(e)           // worth retrying automatically
requiresUserAction(e)    // needs the user to do something
```

## Events

```ts
interface RemoteChangeEvent {
  keys: string[]
  reason: 'serverChange' | 'initialSync' | 'quotaViolation' | 'accountChange' | 'unknown'
  provider: ProviderName
}

interface AccountChangeEvent {
  status: AccountStatus
  identityChanged: boolean   // a DIFFERENT Apple ID is now signed in
  provider: ProviderName
}
```

`identityChanged: true` means every user-scoped cache must be dropped. Native events are buffered until JS binds its listener, so an event that fires during startup is delivered rather than lost - or crashing.

## Account status

```ts
type AccountStatus =
  | 'available'
  | 'noAccount'
  | 'restricted'
  | 'temporarilyUnavailable'
  | 'couldNotDetermine'
```

Five values, not a boolean: "temporarily unavailable" means retry silently, "no account" means prompt the user, "could not determine" means do nothing yet. Collapsing them loses that distinction.

## Testing

```ts
import { createMemoryProvider } from '@kesha-antonov/react-native-cloud-sync/testing'

const provider = createMemoryProvider({
  initial: { 'k': 'v' },
  faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
  accountStatus: 'available',
  latencyMs: 0,
})
```

| Member | Purpose |
|---|---|
| `dump()` | Backing map, bypassing faults |
| `seed(data)` | Replace data without going through `setItem` |
| `reset()` | Clear data, faults and listeners |
| `setFault(op, fault)` | Install or clear a fault at runtime |
| `emitRemoteChange(e)` | Simulate another device |
| `emitAccountChange(e)` | Simulate sign-out or an Apple ID switch |
| `calls` | Per-operation call counts, for asserting retries |

A `Fault` may carry `times`, so it fails N times and then succeeds - the shape retry and outbox logic must converge on.
