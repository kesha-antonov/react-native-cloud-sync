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

`getItem` resolves `null` only when the key doesn't exist; everything else rejects.

| Export | Provider | Guide |
|---|---|---|
| `icloudKV` | `NSUbiquitousKeyValueStore` | [iCloud key-value store](providers/icloud-kv.md) |
| `icloudKVSync()` | flush pending KV changes | [same](providers/icloud-kv.md#sync-does-not-mean-stored) |
| `cloudKit` | CloudKit private database | [CloudKit](providers/cloudkit.md) |
| `cloudKitZones` | `create` · `list` · `remove` (native only) | [zones](providers/cloudkit.md#custom-zones) |
| `cloudKitAssets` | `save` · `fetch` · `onProgress` (native only) | [assets](providers/cloudkit.md#assets) |
| `cloudKitBackup` | `save` · `restore`, one blob, scoped progress (native only) | [backup/restore helper](providers/cloudkit.md#backuprestore-helper) |
| `googleDrive` | Drive `appDataFolder` | [Google Drive](providers/google-drive.md) |
| `googleDriveFiles` | `save` · `fetch`, resumable/chunked, needs a file adapter | [large files](providers/google-drive.md#large-files) |
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

Pass `destinationUri` for an export - without it the file lands in a **temporary** directory iOS may reclaim. See [letting the user download their backup](recipes.md#let-the-user-download-their-backup).

### `googleDriveFiles`

```ts
save(options: DriveFileSaveOptions): Promise<void>

fetch(options: DriveFileFetchOptions): Promise<string | null>
// destinationUri, or null if nothing was ever saved

interface DriveFileSaveOptions {
  name: string
  fileUri: string
  onProgress?: (e: DriveFileProgressEvent) => void
}

interface DriveFileFetchOptions {
  name: string
  destinationUri: string
  onProgress?: (e: DriveFileProgressEvent) => void
}

interface DriveFileProgressEvent {
  bytesTransferred: number
  bytesTotal: number
  fraction: number            // bytesTransferred / bytesTotal, 0 until known
}
```

Needs `configureGoogleDriveFiles` (see below), or rejects with `ERR_CONTAINER_MISCONFIGURED`.

## `cloudKitEncrypted`

CloudKit's own end-to-end encryption, via `CKRecord.encryptedValues` - a `CloudProvider` like any other.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
```

Encrypted on device with a key from the user's iCloud Keychain. Apple platforms only (`ERR_UNSUPPORTED_PLATFORM` elsewhere), not queryable, record names unencrypted, own record type (`EncryptedKVBlob`). Full guide: [Encryption](encryption.md#cloudkits-native-encryption).

## `icloudDocuments`

Files in the user's own iCloud Drive - visible in Files.app, not hidden in a private database. Apple platforms only. Full guide: [iCloud Drive](providers/icloud-drive.md).

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

Every key *and* value in the iCloud key-value store, in one bridge hop - avoids the N+1 cost of `getAllKeys()` plus a read per key that every other provider needs instead.

Values held as something other than a string (it also accepts numbers, dates, data) are omitted, not coerced - a stringified number wouldn't round-trip through `setItem`.

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

`GoogleDriveConfig` also takes `onDuplicateName` (`'newest'` by default, or `'error'`) for when two offline devices create the same key and Drive ends up with two files - `'newest'` picks by modification time, `'error'` raises `ERR_CONFLICT` instead.

Both REST configs also take `timeoutMs` (defaults under [Timeouts](#timeouts) below). `GoogleDriveConfig` additionally takes `changePollIntervalMs` (default 30000) for `onRemoteChange`.

`sessionStore` lets a `googleDriveFiles.save()` upload resume even after the process itself dies mid-transfer. See [large files](providers/google-drive.md#large-files).

### More than one account

`configureCloudKit`/`configureGoogleDrive` set one client per process - no way to reach two accounts at once (a profile switcher, two tests needing different configs).

```ts
createGoogleDriveProvider(config: GoogleDriveConfig & {
  name?: ProviderName
  changePollIntervalMs?: number
}): CloudProvider

createCloudKitProvider(config: CloudKitRestConfig & {
  name?: ProviderName
}): CloudProvider
```

Each returns a provider that owns its credentials, so several can coexist:

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

`createCloudKitProvider` is REST-only permanently - the native path authenticates as whatever account the *device* is signed into, so on iOS it talks to CloudKit Web Services, not `CloudKit.framework`.

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

type ResolveFn = (candidates: ResolveCandidate[]) => string | null

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

`multiGet`/`multiSet`/`multiRemove` batch **per provider** where possible - CloudKit's array-taking endpoints turn 200 keys into one request; Drive has none, so it loops, same cost as calling `getItem` yourself.

`multiGet` results are positional, so you can zip them against your input, and a missing key is `[key, null]` rather than an omitted entry.

`clear()` enumerates with `getAllKeys()` first. A "delete my data" flow built on a hardcoded key list is a flow that forgets a key.

`getAllItems()` is `getAllKeys()` plus `multiGet()` in one object - costs whatever those cost, and exists because it's the shape a debug screen or data export actually wants.

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

The source is left intact - a copy, not a move. `continueOnError` defaults to true, so a bad key doesn't abort the rest - failures come back in the result.

Values move verbatim, without `codec` - both ends sit behind the same one, so re-encoding would be wasted work.

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

`flushOutbox()` is re-entrant-safe - a second call while one's in flight joins it, and entries added mid-flush aren't clobbered.

The queue is bounded three ways (`outboxMaxEntries`, `outboxMaxAttempts`, `outboxMaxAgeMs`); an abandoned entry is reported through `onDropped`/`FlushResult.dropped`, not silently. `discardPendingWrites` lets the user give up on one from a "pending sync" UI.

### Automatic flushing

```ts
interface AutoFlushConfig {
  onForeground?: boolean                  // default true
  intervalMs?: number                     // default 60000, 0 to disable
}
```

`autoFlush: true` takes the defaults - deliberately not network-aware, to avoid forcing `@react-native-community/netinfo` on every consumer. Call `flushOutbox()` from your own reconnect listener too.

### Encryption at rest

```ts
interface ValueCodec {
  encode: (value: string, key: string) => Promise<string> | string
  decode: (value: string, key: string) => Promise<string> | string
}
```

Applied to values only, never keys - closes Drive's plaintext `appDataFolder` with a cipher of your choice. Ships no crypto of its own; key management is yours.

Encoding runs *before* tiering picks a size-based route - an inflating codec shrinks your effective `kvMaxBytes`. Decoding runs *before* resolvers see a candidate, so they still compare plaintext.

Full guide, including what iCloud and Drive already encrypt for you: [Encryption](encryption.md).

### Key validation

```ts
checkKey(key: string, providers: ProviderName[]): KeyRule | null
sanitizeKey(raw: string, maxBytes?: number): string
```

A key has to work as an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName`, and a Drive filename at once - the store checks up front and rejects with `ERR_INVALID_KEY` rather than an illegal name surfacing later as `BAD_REQUEST`/`ERR_CONTAINER_MISCONFIGURED`.

| Rule | Applies when |
|---|---|
| Non-empty | always |
| ASCII letters, digits, `.`, `_`, `-` only | `cloudKit` / `cloudKitEncrypted` configured |
| No leading `_` (CloudKit reserves it) | `cloudKit` / `cloudKitEncrypted` configured |
| At most 255 characters | `cloudKit` / `cloudKitEncrypted` configured |
| At most 64 **UTF-8 bytes** | `icloudKV` configured |

So `auth/anonymousUserId/v1` is fine key-value-store-only, but rejected once `cloudKit` joins, since it must also serve as a record name.

`checkKey` returns `null` when fine, or `{ reason, provider }` naming the broken rule. `sanitizeKey` rewrites an uncontrolled string into a legal key, truncating and hashing over-long ones (truncation alone would collapse same-prefix keys onto one).

Set `validateKeys: false` if your keys are known good and you would rather not pay for the check.

### Timeouts

`timeoutMs` bounds a single provider operation - neither `fetch` nor CloudKit's stack has one, so a socket could otherwise hang forever, including in `isAvailable()`. Raises retryable `ERR_TIMEOUT`, so a hung write queues (with the outbox on) rather than getting lost.

The REST clients have their own defaults independent of this: 30s for CloudKit, 60s for Drive (one "request" there can be an 8 MiB chunk). Both are configurable through `configureCloudKit` / `configureGoogleDrive`.

### Events

`onRemoteChange`/`onAccountChange` merge every configured provider's events onto the facade, so you subscribe once instead of per provider.

The store also acts on account events: `identityChanged: true` drops memoised availability, calls every provider's `clearCaches()`, and **abandons the outbox** - a queued entry carries no account identity, and could otherwise write the old user's data into the new account.

Call `dispose()` when a store outlives its usefulness - it releases the provider subscriptions and stops auto-flush.

`writeMode` decides whether a write goes to the first available provider (`failover`, the default) or to all of them (`mirror`).

`resolve` changes how a read picks a value - without it, `getItem` takes the first non-null value in provider order (silently stale once an Apple and non-Apple device both write); with it, every provider is consulted, you pick the winner, and disagreeing providers get written back unless `repairOnRead` is false. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).

`OutboxStorage` is **synchronous** - read/written on the write path with nowhere to await, so an async store can't be wrapped directly; use MMKV. The default is in-memory (writes don't survive a restart) - use an MMKV-backed adapter in production, see [the outbox](store.md#making-it-durable).

## Tiering

```ts
interface TieringConfig {
  kvMaxBytes: number       // default 65536
  recordMaxBytes: number   // default 921600
}

const DEFAULT_TIERING: TieringConfig
```

Each threshold caps one provider (`kvMaxBytes` the key-value store, `recordMaxBytes` a CloudKit record field); an oversized value routes to the next provider that's large enough and available. Binary assets aren't part of tiering - see [`cloudKitAssets`](providers/cloudkit.md#assets).

## Resolvers

```ts
resolveByTimestamp(field = 'updatedAt'): ResolveFn
resolveByModifiedAt(options?: { fallback?: ResolveFn }): ResolveFn
resolveByPreferenceOrder: ResolveFn
resolveByUnion(options?: { key?: (item) => string | number }): ResolveFn
resolveFirstOf(...resolvers: ResolveFn[]): ResolveFn
```

`resolveByTimestamp` reads a numeric or ISO-string timestamp out of each JSON candidate and takes the newest - an undatable candidate loses to a datable one, ties keep the earlier provider, and if nothing's datable it falls back to provider order.

`resolveByModifiedAt` orders on the **server's** modification time instead (CloudKit's `modified.timestamp`, Drive's `modifiedTime`), so it works on plain strings and old payloads too. The catch: `NSUbiquitousKeyValueStore` exposes no per-key timestamp, so an `icloudKV` candidate always loses to a dated one; when nothing is dated, `fallback` decides (preference order by default).

`resolveByUnion` is for JSON arrays where two devices adding *different* elements should both survive - favorited item ids, dismissed-tip ids - merging every candidate's array, deduplicated and ordered by first appearance (`key` dedupes objects). Deletions don't propagate (no tombstones), and a non-array candidate is dropped, falling back to preference order if none qualify.

`resolveFirstOf` tries resolvers in turn and takes the first non-null answer - the practical combination for a mixed fleet:

```ts
resolveFirstOf(resolveByModifiedAt(), resolveByTimestamp('updatedAt'))
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

`isCancelled` is separate on purpose - a cancelled operation isn't a fault worth an error toast.

`ErrorCode` is exported as a value, so branches and test fixtures can name a code instead of repeating the string:

```ts
import { ErrorCode } from 'react-native-cloud-sync'

ErrorCode.QUOTA_EXCEEDED   // 'ERR_QUOTA_EXCEEDED'
```

`CloudSyncErrorInfo` is the constructor's optional detail bag - the type behind `retryAfterMs`, `limitBytes`, `actualBytes`, `serverValue`, `provider`, `serverErrorCode`, `cause` - exported for building a `CloudSyncError` in a custom provider.

Full code table: [Error handling](errors.md#codes).

## Base64

```ts
bytesToBase64(bytes: Uint8Array): string
base64ToBytes(base64: string): Uint8Array
```

Bridges `GoogleDriveFileAdapter`'s base64 contract with byte-oriented filesystem APIs - dependency-free and Hermes-safe, unlike `Buffer` or `atob`/`btoa`. See [the adapter](providers/google-drive.md#large-files).

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

`ProviderName` is an **open** union, so `registerProvider`'s custom-provider support (a `'dropbox'` provider) needs no cast at every call site. `string & {}` keeps autocomplete for built-ins while accepting any string; `BuiltInProviderName` is the closed set.

`ItemWithMeta` is what an optional `CloudProvider.getItemWithMeta` returns, feeding `ResolveCandidate.modifiedAt`. `QuotaInfo` is what `getQuota()` reports; `totalBytes` absent means unlimited or unreported, not zero.

`AbortLike` is the abort-signal shape the cancellable APIs accept:

```ts
interface AbortLike {
  readonly aborted: boolean
  addEventListener: (type: 'abort', listener: () => void) => void
  removeEventListener: (type: 'abort', listener: () => void) => void
}
```

Structural rather than the DOM `AbortSignal`, so any polyfill satisfies it and you don't need `lib.dom` in your tsconfig - a real `AbortSignal` matches it too.

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
  multiSet?: (entries: [string, string][]) => Promise<void>
  multiRemove?: (keys: string[]) => Promise<void>
  getQuota?: () => Promise<QuotaInfo | null>
  clearCaches?: () => void
  onRemoteChange?: (l: (e: RemoteChangeEvent) => void) => Unsubscribe
  onAccountChange?: (l: (e: AccountChangeEvent) => void) => Unsubscribe
}
```

Everything optional has a working fallback - a minimal provider is six methods. Implement `multiGet`/`multiSet`/`multiRemove` only when your backend genuinely batches; a fake one just hides N round trips behind one call.

`clearCaches` matters: the store calls it on an identity change, since anything memoised belongs to the account that just left.

## React hooks

A separate entry point, so the main one stays free of a React import:

```ts
import { useCloudItem } from 'react-native-cloud-sync/hooks'
```

```ts
useCloudItem<T>(store: CloudStore, key: string, options?: UseCloudItemOptions<T>): UseCloudItemResult<T>
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
```

```tsx
function SettingsScreen () {
  const { value, setValue, loading, error } = useCloudItem<Settings>(store, 'settings')

  if (loading) return <Spinner />
  if (error != null) return <SyncError code={error.code} />
  return <SettingsForm value={value} onChange={setValue} />
}
```

Every app writes the same three, with the same two bugs - a stale response overwriting a newer one, and `setState` after unmount - handled once here. `useCloudItem` writes optimistically and doesn't revert on error, since the outbox will still deliver it; a failed read likewise keeps the last known value rather than blanking the screen.

`useAccountStatus`'s `identityChanged` is **latched**, not momentary: it stays true once a different identity has signed in, so a screen that mounts just after the event still sees it.

## Diagnostics

```ts
setLogsEnabled(enabled: boolean): void
```

Off by default - a storage library logging every read is noise, and payloads can contain user data that should not reach a device log.
