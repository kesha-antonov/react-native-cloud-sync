# API Reference

Compact reference. For narrative, see the provider guides and [the facade](store.md).

## Providers

All providers implement `CloudProvider`:

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

`getItem` resolves `null` if and only if the key does not exist. Every other outcome rejects.

| Export | Provider | Guide |
|---|---|---|
| `icloudKV` | `NSUbiquitousKeyValueStore` | [iCloud key-value store](providers/icloud-kv.md) |
| `icloudKVSync()` | flush pending KV changes | [same](providers/icloud-kv.md#sync-does-not-mean-stored) |
| `cloudKit` | CloudKit private database | [CloudKit](providers/cloudkit.md) |
| `cloudKitZones` | `create` · `list` · `remove` (native only) | [zones](providers/cloudkit.md#custom-zones) |
| `cloudKitAssets` | `save` · `fetch` · `onProgress` (native only) | [assets](providers/cloudkit.md#assets) |
| `googleDrive` | Drive `appDataFolder` | [Google Drive](providers/google-drive.md) |
| `createMemoryProvider` | in-memory + fault injection | [Testing](testing.md) |

### `cloudKitZones`

```ts
create(zoneName: string): Promise<void>
list(): Promise<string[]>
remove(zoneName: string): Promise<void>
```

### `cloudKitAssets`

```ts
save(options: {
  recordName: string
  fieldName: string
  fileUri: string            // file:// URL or a plain path
  recordType?: string        // default 'KVBlob'
  zoneName?: string | null
}): Promise<void>

fetch(options: {
  recordName: string
  fieldName: string
  zoneName?: string | null
}): Promise<string | null>   // local path, or null if absent

onProgress(cb: (e: AssetProgressEvent) => void): Unsubscribe
```

## Configuration

```ts
configureCloudKit(config: CloudKitRestConfig): void
isCloudKitConfigured(): boolean

configureGoogleDrive(config: GoogleDriveConfig): void
isGoogleDriveConfigured(): boolean
```

```ts
interface CloudKitRestConfig {
  containerIdentifier: string
  apiToken: string                        // a Client token, never server-to-server
  environment: 'development' | 'production'
  getAuthToken: () => Promise<string | null> | string | null
  onAuthExpired?: () => Promise<void> | void
  fetchImpl?: typeof fetch                // overridable for tests
}

interface GoogleDriveConfig {
  getAccessToken: () => Promise<string | null> | string | null
  onAuthExpired?: () => Promise<void> | void
  fetchImpl?: typeof fetch
}
```

## `createCloudStore`

```ts
createCloudStore(options: CloudStoreOptions & {
  outboxStorage?: OutboxStorage
}): CloudStore
```

```ts
interface CloudStoreOptions {
  providers: ProviderName[]               // preference order
  tiering?: TieringConfig | 'auto' | 'off'
  outbox?: boolean                        // default true
  onError?: (e: CloudSyncError) => void
}

interface OutboxStorage {
  getString: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
}

interface CloudStore {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  getAllKeys: () => Promise<string[]>
  migrate: (o: { from: ProviderName, to: ProviderName }) => Promise<{ copied: string[] }>
  flushOutbox: () => Promise<{ drained: number, remaining: number }>
  pendingWrites: () => OutboxEntry[]
  registerProvider: (p: CloudProvider) => void
}
```

The default `outboxStorage` is in-memory, so queued writes do not survive a restart. Pass an MMKV- or AsyncStorage-backed adapter in production - see [the outbox](store.md#making-it-durable).

## Tiering

```ts
interface TieringConfig {
  kvMaxBytes: number       // default 65536
  recordMaxBytes: number   // default 921600
}

const DEFAULT_TIERING: TieringConfig
```

Values above `kvMaxBytes` are routed away from the key-value store to the first record-capable provider in your list. Binary assets are not part of tiering - see [`cloudKitAssets`](providers/cloudkit.md#assets).

## Errors

```ts
class CloudSyncError extends Error {
  readonly code: ErrorCode
  readonly retryAfterMs?: number
  readonly limitBytes?: number
  readonly actualBytes?: number
  readonly serverValue?: string | null
  readonly provider?: string
  readonly serverErrorCode?: string
  readonly cause?: unknown
}

isCloudSyncError(e: unknown): e is CloudSyncError
isRetryable(e: unknown): boolean
requiresUserAction(e: unknown): boolean
```

Full code table: [Error handling](errors.md#codes).

## Types

```ts
type AccountStatus =
  | 'available' | 'noAccount' | 'restricted'
  | 'temporarilyUnavailable' | 'couldNotDetermine'

type ChangeReason =
  | 'serverChange' | 'initialSync' | 'quotaViolation'
  | 'accountChange' | 'unknown'

type ProviderName = 'icloudKV' | 'cloudKit' | 'googleDrive' | 'memory'

interface RemoteChangeEvent { keys: string[], reason: ChangeReason, provider: ProviderName }
interface AccountChangeEvent { status: AccountStatus, identityChanged: boolean, provider: ProviderName }
interface AssetProgressEvent { recordName: string, fieldName: string, bytesTransferred: number, bytesTotal: number }
interface OutboxEntry { key: string, value: string | null, provider: ProviderName, attempts: number, nextAttemptAt: number, enqueuedAt: number }

type Unsubscribe = () => void
```

## Diagnostics

```ts
setLogsEnabled(enabled: boolean): void
```

Off by default - a storage library logging every read is noise, and payloads can contain user data that should not reach a device log.
