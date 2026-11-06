# API Reference

Compact reference. For narrative, see the provider guides and [the facade](store.md).

## Providers

Every provider implements [`CloudProvider`](#the-provider-contract). `getItem` resolves `null` only when the key doesn't exist; everything else rejects.

| Export | Provider | Guide |
|---|---|---|
| `icloudKV` | `NSUbiquitousKeyValueStore` | [iCloud key-value store](providers/icloud-kv.md) |
| `icloudKVSync()` | flush pending KV changes | [same](providers/icloud-kv.md#sync-does-not-mean-stored) |
| `cloudKit` | CloudKit private database | [CloudKit](providers/cloudkit.md) |
| `cloudKitZones` | `create`, `list`, `remove` (native only) | [zones](providers/cloudkit.md#custom-zones) |
| `cloudKitAssets` | `save`, `fetch`, `cancel`, `onProgress` (native only) | [assets](providers/cloudkit.md#assets) |
| `cloudKitBackup` | `save`, `restore`, `cancel`: one blob, scoped progress (native only) | [backup/restore helper](providers/cloudkit.md#backuprestore-helper) |
| `googleDrive` | Drive `appDataFolder` | [Google Drive](providers/google-drive.md) |
| `googleDriveFiles` | `save`, `fetch`: resumable, chunked, needs a file adapter | [large files](providers/google-drive.md#large-files) |
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
  destinationUri?: string    // where it lands; defaults to a temporary path
}): Promise<string | null>   // local path, or null if absent

cancel(options: { recordName: string, fieldName: string }): Promise<boolean>

onProgress(cb: (e: AssetProgressEvent) => void): Unsubscribe
```

### `cloudKitBackup`

```ts
save(fileUri: string, options?: BackupOptions): Promise<void>

restore(options?: BackupOptions): Promise<string | null>
// local path, or null if nothing was ever saved

cancel(options?: { recordName?: string, fieldName?: string }): Promise<boolean>
// rejects the running save/restore with ERR_CANCELLED; true if there was one

interface BackupOptions {
  recordName?: string        // default 'backup'
  fieldName?: string         // default 'file'
  zoneName?: string | null
  onProgress?: (e: BackupProgressEvent) => void
  destinationUri?: string    // restore only; where the file lands
}

interface BackupProgressEvent {
  bytesTransferred: number
  bytesTotal: number
  fraction: number            // bytesTransferred / bytesTotal, 0 until known
}
```

Pass `destinationUri` for an export: without it the file lands in a **temporary** directory iOS may reclaim. See [letting the user download their backup](recipes.md#let-the-user-download-their-backup).

### `googleDriveFiles`

```ts
save(options: DriveFileSaveOptions): Promise<void>

fetch(options: DriveFileFetchOptions): Promise<string | null>
// destinationUri, or null if nothing was ever saved

interface DriveFileSaveOptions {
  name: string
  fileUri: string
  onProgress?: (e: DriveFileProgressEvent) => void
  signal?: AbortLike                      // abort rejects with ERR_CANCELLED
}

interface DriveFileFetchOptions {
  name: string
  destinationUri: string
  onProgress?: (e: DriveFileProgressEvent) => void
  signal?: AbortLike
}

interface DriveFileProgressEvent {
  bytesTransferred: number
  bytesTotal: number
  fraction: number            // bytesTransferred / bytesTotal, 0 until known
}
```

Needs `configureGoogleDriveFiles` (see below), or rejects with `ERR_CONTAINER_MISCONFIGURED`.

## `cloudKitEncrypted`

CloudKit's own end-to-end encryption via `CKRecord.encryptedValues`, as a regular `CloudProvider`.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
```

- Encrypted on device with a key from the user's iCloud Keychain.
- Apple platforms only (`ERR_UNSUPPORTED_PLATFORM` elsewhere).
- Not queryable; record names are not encrypted.
- Own record type `EncryptedKVBlob`, records named `rncs-enc.<key>` (record names are unique across types). So keys max out at 246 characters, and plain `cloudKit` rejects keys with that prefix.

Full guide: [Encryption](encryption.md#cloudkits-native-encryption).

## `icloudDocuments`

Files in the user's own iCloud Drive, visible in Files.app. Apple platforms only. Full guide: [iCloud Drive](providers/icloud-drive.md).

```ts
icloudDocuments.isAvailable(): Promise<boolean>
icloudDocuments.save(o: { fileUri: string, name: string }): Promise<string>
icloudDocuments.fetch(o: { name: string } & DocumentFetchOptions): Promise<string | null>
icloudDocuments.list(): Promise<DocumentEntry[]>
icloudDocuments.remove(name: string): Promise<boolean>
```

```ts
interface DocumentEntry {
  name: string
  sizeBytes: number
  isDownloaded: boolean      // false when it exists in the account but not on this device
  isDownloading: boolean
}

interface DocumentFetchOptions {
  destinationUri?: string    // copy out of the container once downloaded
  timeoutMs?: number         // default 60000
}
```

## `icloudKVGetAllItems`

```ts
icloudKVGetAllItems(): Promise<Record<string, string>>
```

Every key and value in the iCloud key-value store in one bridge hop, instead of `getAllKeys()` plus a read per key.

Non-string values (numbers, dates, data) are omitted, not coerced: a stringified number wouldn't round-trip through `setItem`.

## Configuration

```ts
configureCloudKit(config: CloudKitRestConfig): void
isCloudKitConfigured(): boolean

configureGoogleDrive(config: GoogleDriveConfig): void
isGoogleDriveConfigured(): boolean

configureGoogleDriveFiles(adapter: GoogleDriveFileAdapter): void
isGoogleDriveFilesConfigured(): boolean
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
  chunkBytes?: number                     // googleDriveFiles chunk size, default 8 MiB
  sessionStore?: GoogleDriveSessionStore  // persists an upload session across a process restart
}

interface GoogleDriveFileAdapter {
  statSize: (uri: string) => Promise<number>
  readChunk: (uri: string, position: number, length: number) => Promise<string>   // base64
  writeChunk: (uri: string, base64: string) => Promise<void>                      // creates/overwrites
  appendChunk: (uri: string, base64: string) => Promise<void>
}

interface GoogleDriveSessionStore {
  get: (name: string) => Promise<GoogleDriveUploadSession | null>
  set: (name: string, session: GoogleDriveUploadSession) => Promise<void>
  remove: (name: string) => Promise<void>
}

interface GoogleDriveUploadSession {
  sessionUrl: string
  size: number                            // the source size the session was started against
}
```

More options:

- Both REST configs: `timeoutMs` (defaults under [Timeouts](#timeouts)).
- `GoogleDriveConfig.changePollIntervalMs`: poll interval for `onRemoteChange`, default 30000.
- `GoogleDriveConfig.onDuplicateName`: when two offline devices create the same key and Drive holds two files. `'newest'` (default) picks by modification time; `'error'` raises `ERR_CONFLICT`.
- `sessionStore`: lets a `googleDriveFiles.save()` upload resume after the process dies mid-transfer. See [large files](providers/google-drive.md#large-files).

### More than one account

`configureCloudKit`/`configureGoogleDrive` set one client per process. To reach two accounts at once (a profile switcher, tests with different configs), create providers that own their credentials:

```ts
createGoogleDriveProvider(config: GoogleDriveConfig & {
  name?: ProviderName
  changePollIntervalMs?: number
}): CloudProvider

createCloudKitProvider(config: CloudKitRestConfig & {
  name?: ProviderName
}): CloudProvider
```

```ts
const personal = createGoogleDriveProvider({
  name: 'drive:personal',
  getAccessToken: () => personalToken(),
})
const work = createGoogleDriveProvider({
  name: 'drive:work',
  getAccessToken: () => workToken(),
})

const store = createCloudStore({ providers: ['drive:personal'] })
store.registerProvider(personal)
store.registerProvider(work)

await store.migrate({ from: 'drive:personal', to: 'drive:work' })
```

`createCloudKitProvider` is always REST, even on iOS: the native path can only use the account the device is signed into.

## `createCloudStore`

```ts
createCloudStore(options: CloudStoreOptions & {
  outboxStorage?: OutboxStorage
}): CloudStore
```

```ts
interface CloudStoreOptions {
  providers: ProviderName[]               // preference order
  writeMode?: 'failover' | 'mirror'       // default 'failover'
  resolve?: ResolveFn                     // consult all providers, pick a winner
  repairOnRead?: boolean                  // default true when resolve is set
  tiering?: TieringConfig | 'auto' | 'off'
  outbox?: boolean                        // default true
  outboxMaxEntries?: number               // default 1000
  outboxMaxAttempts?: number              // default 12
  outboxMaxAgeMs?: number                 // default 7 days
  autoFlush?: boolean | AutoFlushConfig   // default off
  availabilityTtlMs?: number              // default 3000
  timeoutMs?: number                      // default off
  codec?: ValueCodec                      // encrypt at rest
  validateKeys?: boolean                  // default true
  onError?: (e: CloudSyncError) => void
  onDropped?: (d: DroppedWrite) => void
}

interface ResolveFn {
  (candidates: ResolveCandidate[]): string | null
  usesModifiedAt?: boolean                // false keeps multiGet one request per provider
}

interface ResolveCandidate {
  provider: ProviderName
  value: string
  modifiedAt?: number                     // server time, when the provider reports one
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

  multiGet: (keys: string[]) => Promise<[string, string | null][]>
  multiSet: (entries: [string, string][]) => Promise<void>
  multiRemove: (keys: string[]) => Promise<void>
  getAllItems: () => Promise<Record<string, string>>
  clear: () => Promise<{ removed: string[] }>

  getQuota: () => Promise<QuotaInfo[]>
  migrate: (o: MigrateOptions) => Promise<MigrateResult>

  flushOutbox: () => Promise<FlushResult>
  pendingWrites: () => OutboxEntry[]
  discardPendingWrites: (filter?: (e: OutboxEntry) => boolean) => number

  registerProvider: (p: CloudProvider) => void
  onRemoteChange: (l: (e: RemoteChangeEvent) => void) => Unsubscribe
  onAccountChange: (l: (e: AccountChangeEvent) => void) => Unsubscribe
  dispose: () => void
}
```

### Batch operations

- `multiGet`/`multiSet`/`multiRemove` batch **per provider** where the backend can: 200 keys are one CloudKit request. Drive has no batch endpoint, so it loops.
- With `resolve` set, `multiGet`, `getAllItems` and `useCloudItems` resolve each key as `getItem` does, with server timestamps and read repair. Timestamps come from the provider's `multiGetWithMeta`, else one `getItemWithMeta` per key, else plain `multiGet`. A resolver with `usesModifiedAt: false` skips them (one request per provider). Built-in resolvers set the flag; a custom resolver that leaves it undefined is assumed to read `modifiedAt`.
- `multiGet` results are positional; a missing key is `[key, null]`, not omitted.
- `clear()` enumerates with `getAllKeys()` first, so it can't miss a key.
- `getAllItems()` is `getAllKeys()` plus `multiGet()` as one object, for debug screens and exports.

### Migration

```ts
interface MigrateOptions {
  from: ProviderName
  to: ProviderName
  continueOnError?: boolean               // default true
  filter?: (key: string) => boolean
  onProgress?: (done: number, total: number) => void
}

interface MigrateResult {
  copied: string[]
  skipped: string[]                       // present at the source but holding nothing
  failed: { key: string, error: CloudSyncError }[]
}
```

A copy, not a move: the source is left intact. By default a bad key doesn't abort the rest; failures come back in `failed`. Values move verbatim, without `codec` (both ends share it).

### The outbox

```ts
interface FlushResult {
  drained: number
  remaining: number
  dropped: DroppedWrite[]
}

interface DroppedWrite {
  entry: OutboxEntry
  reason: DropReason
  error?: CloudSyncError
}

type DropReason =
  | 'notRetryable' | 'tooManyAttempts' | 'expired'
  | 'queueFull' | 'accountChanged' | 'discarded'
```

`flushOutbox()` is re-entrant: a second call joins the one in flight, and entries added mid-flush are kept.

The queue is bounded by `outboxMaxEntries`, `outboxMaxAttempts` and `outboxMaxAgeMs`. Abandoned entries are reported through `onDropped` and `FlushResult.dropped`. `discardPendingWrites` lets the user give up on entries from a "pending sync" UI.

### Automatic flushing

```ts
interface AutoFlushConfig {
  onForeground?: boolean                  // default true
  intervalMs?: number                     // default 60000, 0 to disable
}
```

`autoFlush: true` takes the defaults. It is not network-aware (no `@react-native-community/netinfo` dependency), so also call `flushOutbox()` from your own reconnect listener.

### Encryption at rest

```ts
interface ValueCodec {
  encode: (value: string, key: string) => Promise<string> | string
  decode: (value: string, key: string) => Promise<string> | string
}
```

Applies to values only, never keys. Bring your own cipher and key management; none ships. Encoding runs before tiering, so an inflating codec shrinks your effective `kvMaxBytes`. Decoding runs before resolvers, so they compare plaintext. Guide: [Encryption](encryption.md).

### Key validation

```ts
checkKey(key: string, providers: ProviderName[]): KeyRule | null
sanitizeKey(raw: string, maxBytes?: number): string
```

A key must work as an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Drive filename at once. The store checks before the request and rejects with `ERR_INVALID_KEY`, instead of a later `BAD_REQUEST`/`ERR_CONTAINER_MISCONFIGURED`.

| Rule | Applies when |
|---|---|
| Non-empty | always |
| ASCII letters, digits, `.`, `_`, `-` only | `cloudKit` / `cloudKitEncrypted` configured |
| No leading `_` (CloudKit reserves it) | `cloudKit` / `cloudKitEncrypted` configured |
| At most 255 characters | `cloudKit` / `cloudKitEncrypted` configured |
| At most 64 **UTF-8 bytes** | `icloudKV` configured |

So `auth/anonymousUserId/v1` is fine with `icloudKV` alone but rejected once `cloudKit` joins.

- `checkKey` returns `null` when the key is fine, or `{ reason, provider }` naming the broken rule.
- `sanitizeKey` turns any string into a legal key. A legal key that fits `maxBytes` (default 64) is returned unchanged. Others are cleaned, truncated and suffixed with `--` plus a 14-character hash of the original, so distinct inputs stay distinct (`"a b"` vs `"a-b"`). `maxBytes` below 16 throws a `RangeError`.
- `validateKeys: false` skips the check.

### Timeouts

`timeoutMs` bounds a single provider operation, including `isAvailable()`; neither `fetch` nor CloudKit has a timeout of its own. It raises retryable `ERR_TIMEOUT`, so with the outbox on a hung write is queued, not lost.

The REST clients have separate defaults: 30s for CloudKit, 60s for Drive (one request can be an 8 MiB chunk). Set them through `configureCloudKit` / `configureGoogleDrive`.

### Events

`onRemoteChange`/`onAccountChange` merge every configured provider's events, so you subscribe once.

On `identityChanged: true` the store drops memoised availability, calls every provider's `clearCaches()` and **abandons the outbox**: queued entries carry no account identity and would write the old user's data into the new account.

`dispose()` releases provider subscriptions and stops auto-flush.

### Other options

- `writeMode`: `failover` (default) writes to the first available provider, `mirror` to all of them.
- `resolve`: without it, `getItem` takes the first non-null value in provider order, which goes stale once Apple and non-Apple devices both write. With it, every provider is read, your resolver picks the winner, and disagreeing providers are repaired unless `repairOnRead` is false. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).
- `outboxStorage`: must be **synchronous** (it runs on the write path), so use MMKV rather than an async store. The default is in-memory and lost on restart. See [the outbox](store.md#making-it-durable).

## Tiering

```ts
interface TieringConfig {
  kvMaxBytes: number       // default 65536
  recordMaxBytes: number   // default 921600
}

const DEFAULT_TIERING: TieringConfig
```

`kvMaxBytes` caps the key-value store, `recordMaxBytes` a CloudKit record field. An oversized value routes to the next provider that is large enough and available. Binary assets are not tiered; see [`cloudKitAssets`](providers/cloudkit.md#assets).

## Resolvers

```ts
resolveByTimestamp(field = 'updatedAt'): ResolveFn
resolveByModifiedAt(options?: { fallback?: ResolveFn }): ResolveFn
resolveByPreferenceOrder: ResolveFn
resolveByUnion(options?: { key?: (item) => string | number }): ResolveFn
resolveFirstOf(...resolvers: ResolveFn[]): ResolveFn
```

| Resolver | Picks |
|---|---|
| `resolveByTimestamp` | Newest by a numeric or ISO timestamp field in the JSON value. Datable beats undatable; ties keep the earlier provider; nothing datable falls back to provider order |
| `resolveByModifiedAt` | Newest by **server** modification time (CloudKit `modified.timestamp`, Drive `modifiedTime`), so it works on plain strings. `icloudKV` has no per-key timestamp and always loses to a dated candidate; with nothing dated, `fallback` decides (default: preference order) |
| `resolveByUnion` | Merges JSON arrays, deduplicated, in order of first appearance (`key` dedupes objects). For sets like favorite ids. Deletions don't propagate; non-array candidates are dropped, falling back to preference order if none qualify |
| `resolveFirstOf` | First non-null answer from the resolvers in turn |

`resolveByModifiedAt` never returns `null`, so `resolveFirstOf` can't chain past it. For a mixed fleet, pass the second resolver as its `fallback`:

```ts
resolveByModifiedAt({ fallback: resolveByTimestamp('updatedAt') })
```

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
isCancelled(e: unknown): boolean
```

`isCancelled` is separate because a cancellation isn't a fault to toast.

`ErrorCode` is exported as a value:

```ts
import { ErrorCode } from 'react-native-cloud-sync'

ErrorCode.QUOTA_EXCEEDED   // 'ERR_QUOTA_EXCEEDED'
```

`CloudSyncErrorInfo` is the constructor's optional detail bag (`retryAfterMs`, `limitBytes`, `actualBytes`, `serverValue`, `provider`, `serverErrorCode`, `cause`), for building a `CloudSyncError` in a custom provider.

Full code table: [Error handling](errors.md#codes).

## Base64

```ts
bytesToBase64(bytes: Uint8Array): string
base64ToBytes(base64: string): Uint8Array
```

Connects `GoogleDriveFileAdapter`'s base64 contract to byte-oriented filesystem APIs. No dependencies, Hermes-safe (unlike `Buffer` or `atob`/`btoa`). `base64ToBytes` ignores whitespace and throws a `TypeError` on invalid input. See [the adapter](providers/google-drive.md#large-files).

## Types

```ts
type AccountStatus =
  | 'available' | 'noAccount' | 'restricted'
  | 'temporarilyUnavailable' | 'couldNotDetermine'

type ChangeReason =
  | 'serverChange' | 'initialSync' | 'quotaViolation'
  | 'accountChange' | 'unknown'

type BuiltInProviderName = 'icloudKV' | 'cloudKit' | 'googleDrive' | 'memory'
type ProviderName = BuiltInProviderName | (string & {})

type WriteMode = 'failover' | 'mirror'

interface RemoteChangeEvent { keys: string[], reason: ChangeReason, provider: ProviderName }
interface AccountChangeEvent { status: AccountStatus, identityChanged: boolean, provider: ProviderName }
interface AssetProgressEvent { recordName: string, fieldName: string, bytesTransferred: number, bytesTotal: number }
interface OutboxEntry { key: string, value: string | null, provider: ProviderName, attempts: number, nextAttemptAt: number, enqueuedAt: number, lastErrorCode?: string }

interface ItemWithMeta { value: string, modifiedAt?: number }
interface QuotaInfo { usedBytes?: number, totalBytes?: number, provider: ProviderName }

type Unsubscribe = () => void
```

- `ProviderName` is an **open** union: custom names like `'dropbox'` need no cast, built-ins still autocomplete. `BuiltInProviderName` is the closed set.
- `ItemWithMeta` is returned by the optional `getItemWithMeta` / `multiGetWithMeta` and feeds `ResolveCandidate.modifiedAt`.
- `QuotaInfo.totalBytes` absent means unlimited or unreported, not zero.

`AbortLike` is the abort-signal shape the cancellable APIs accept:

```ts
interface AbortLike {
  readonly aborted: boolean
  addEventListener: (type: 'abort', listener: () => void) => void
  removeEventListener: (type: 'abort', listener: () => void) => void
}
```

It is structural, so a real `AbortSignal` or any polyfill fits, without `lib.dom` in your tsconfig.

## The provider contract

```ts
interface CloudProvider {
  readonly name: ProviderName
  isAvailable: () => Promise<boolean>
  getAccountStatus: () => Promise<AccountStatus>
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  getAllKeys: () => Promise<string[]>

  // All optional. The store falls back to the required methods above.
  getItemWithMeta?: (key: string) => Promise<ItemWithMeta | null>
  multiGet?: (keys: string[]) => Promise<(string | null)[]>
  multiGetWithMeta?: (keys: string[]) => Promise<(ItemWithMeta | null)[]>
  multiSet?: (entries: [string, string][]) => Promise<void>
  multiRemove?: (keys: string[]) => Promise<void>
  getQuota?: () => Promise<QuotaInfo | null>
  clearCaches?: () => void
  onRemoteChange?: (l: (e: RemoteChangeEvent) => void) => Unsubscribe
  onAccountChange?: (l: (e: AccountChangeEvent) => void) => Unsubscribe
}
```

- Every optional method has a fallback; a minimal provider implements the six required ones.
- Implement `multiGet`/`multiSet`/`multiRemove` only if your backend really batches.
- `multiGetWithMeta` serves a resolving `multiGet` whose resolver reads `modifiedAt`. `cloudKit` implements it (timestamps over REST only; the native bridge returns values without `modifiedAt`), and so does `googleDrive` (one listing per 50 keys plus one download per key).
- `clearCaches` is called on an identity change: anything memoised belongs to the previous account.

## React hooks

A separate entry point, so the main one doesn't import React. Guide: [React hooks](hooks.md).

```ts
import { useCloudItem } from 'react-native-cloud-sync/hooks'
```

```ts
useCloudItem<T>(store: CloudStore, key: string, options?: UseCloudItemOptions<T>): UseCloudItemResult<T>
useCloudItems<T>(store: CloudStore, keys: string[], options?: UseCloudItemsOptions<T>): UseCloudItemsResult<T>
useCloudCollection<T>(store: CloudStore, prefix: string, options?: UseCloudItemsOptions<T>): UseCloudCollectionResult<T>
useAccountStatus(provider: CloudProvider): UseAccountStatusResult
usePendingWrites(store: CloudStore, pollIntervalMs?: number): UsePendingWritesResult
useRemoteChange(store: CloudStore, listener: (e: RemoteChangeEvent) => void): void
useQuota(store: CloudStore): { quota: QuotaInfo[], loading: boolean, refresh: () => Promise<void> }
```

```ts
interface UseCloudItemResult<T> {
  value: T | null
  loading: boolean
  error: CloudSyncError | null
  setValue: (next: T) => Promise<void>
  remove: () => Promise<void>
  refresh: () => Promise<void>
}

interface UseCloudItemOptions<T> {
  initialValue?: T | null
  parse?: (raw: string) => T          // default JSON.parse
  serialize?: (value: T) => string    // default JSON.stringify
  watch?: boolean                     // re-read on remote change, default true
}

interface UseCloudItemsResult<T> {
  values: Record<string, T | null>    // absent key = not fetched yet, null = fetched and missing
  loading: boolean                    // true only for the initial fetch and refresh()
  error: CloudSyncError | null
  setValue: (key: string, next: T) => Promise<void>
  remove: (key: string) => Promise<void>
  refresh: () => Promise<void>        // re-fetches every tracked key
}

interface UseCloudItemsOptions<T> {
  parse?: (raw: string) => T          // default JSON.parse
  serialize?: (value: T) => string    // default JSON.stringify
  watch?: boolean                     // re-fetch a key on remote change, default true
}

interface UseCloudCollectionResult<T> extends UseCloudItemsResult<T> {
  keys: string[]                      // every key currently starting with `prefix`
}
```

- `useCloudItem` writes optimistically and doesn't revert on error (the outbox still delivers). A failed read keeps the last known value.
- `useCloudItems` reads a list of keys with one batched `multiGet`, resolving like `getItem` when the store has `resolve`. `useCloudCollection` adds the live list of keys starting with `prefix`.
- `useAccountStatus`'s `identityChanged` is **latched**: it stays true once a different identity has signed in.

## Diagnostics

```ts
setLogsEnabled(enabled: boolean): void
```

Off by default: logs are noisy and payloads can contain user data.
