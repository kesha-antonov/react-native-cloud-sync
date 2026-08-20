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
}): Promise<string | null>   // local path, or null if absent

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
}

interface BackupProgressEvent {
  bytesTransferred: number
  bytesTotal: number
  fraction: number            // bytesTransferred / bytesTotal, 0 until known
}
```

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

Needs `configureGoogleDriveFiles` - see below. Rejects with `ERR_CONTAINER_MISCONFIGURED` until then.

## `cloudKitEncrypted`

CloudKit's own end-to-end encryption, via `CKRecord.encryptedValues`. A `CloudProvider` like any other, so it works directly or through the facade.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
```

Values are encrypted on device with a key from the user's iCloud Keychain; Apple stores ciphertext and cannot read it. Apple platforms only - the key never reaches Apple's servers, so CloudKit Web Services has nothing to decrypt with and the Android/web paths reject with `ERR_UNSUPPORTED_PLATFORM`. Values are not queryable, record names are *not* encrypted, and it uses its own record type (`EncryptedKVBlob`) so it cannot collide with `cloudKit`'s schema.

Full guide: [Encryption](encryption.md#cloudkits-native-encryption).

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

Every key *and* value in the iCloud key-value store, in one call. Not part of the `CloudProvider` contract, because no other provider can do it cheaply - CloudKit and Drive would both have to fetch every record. Here the whole store is already a local dictionary, so this is one bridge hop against the N+1 that `getAllKeys()` plus a read per key costs.

Values the store holds as something other than a string (it also accepts numbers, dates and data) are omitted rather than coerced, since a stringified number would not round-trip back through `setItem`.

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
}

interface GoogleDriveFileAdapter {
  statSize: (uri: string) => Promise<number>
  readChunk: (uri: string, position: number, length: number) => Promise<string>   // base64
  writeChunk: (uri: string, base64: string) => Promise<void>                      // creates/overwrites
  appendChunk: (uri: string, base64: string) => Promise<void>
}
```

Both REST configs also take `timeoutMs` - 30000 for CloudKit, 60000 for Drive by default. `GoogleDriveConfig` additionally takes `changePollIntervalMs` (default 30000) for `onRemoteChange`.

### More than one account

`configureCloudKit` and `configureGoogleDrive` set one client for the whole process, which is right for a normal app but leaves no way to reach two accounts at once - a profile switcher, a "copy my data to my other account" flow, or two tests that need different configurations.

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

`createCloudKitProvider` is REST-only, and that is not a limitation waiting to be lifted: the native path authenticates as whatever iCloud account the *device* is signed into, so "a different set of credentials" has no meaning there. On iOS it therefore talks to CloudKit Web Services rather than to `CloudKit.framework`.

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

`multiGet`, `multiSet` and `multiRemove` batch **per provider** where the provider has a batch endpoint. CloudKit's `/records/lookup` and `/records/modify` both take arrays, so reading 200 keys is one request rather than 200. Google Drive stores one file per key and has no batch content endpoint, so the store falls back to a sequential loop there - same cost as calling `getItem` yourself, but honest about it rather than pretending.

`multiGet` results are positional, so you can zip them against your input, and a missing key is `[key, null]` rather than an omitted entry.

`clear()` enumerates with `getAllKeys()` first. A "delete my data" flow built on a hardcoded key list is a flow that forgets a key.

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

The source is left intact - this is a copy, not a move, so a failed migration cannot lose data. `continueOnError` defaults to true because aborting on the first bad key leaves the user half migrated with no record of how far it got; the failures come back in the result instead.

Values move verbatim, without passing through `codec`. Both ends sit behind the same codec, so decoding only to re-encode would be wasted work - and for a codec with a random nonce it would rewrite every byte.

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

`flushOutbox()` is re-entrant-safe: a second call while one is in flight joins it rather than re-sending every entry. Entries added *during* a flush are preserved rather than clobbered by the snapshot being written back.

The queue is bounded three ways - `outboxMaxEntries`, `outboxMaxAttempts` and `outboxMaxAgeMs`. Whenever an entry is abandoned it is reported through `onDropped` and in `FlushResult.dropped`, so the loss is visible rather than silent. `discardPendingWrites` lets the user give up on one from a "pending sync" UI.

### Automatic flushing

```ts
interface AutoFlushConfig {
  onForeground?: boolean                  // default true
  intervalMs?: number                     // default 60000, 0 to disable
}
```

`autoFlush: true` takes the defaults. Deliberately *not* network-aware: that needs `@react-native-community/netinfo`, and requiring every consumer to install it to save one line in the ones that want it is a bad trade. Call `flushOutbox()` from your own reconnect listener as well if you have one.

### Encryption at rest

```ts
interface ValueCodec {
  encode: (value: string, key: string) => Promise<string> | string
  decode: (value: string, key: string) => Promise<string> | string
}
```

Applied to values only, never to keys. Drive's `appDataFolder` is plaintext to anything holding the account's OAuth token; this is the seam for closing that with a cipher you chose. The package ships no crypto of its own - key management is your problem, and bundling a cipher would make it look solved.

Encoding runs *before* tiering picks a destination, so a value is routed by the size it will actually occupy. A codec that inflates its input therefore makes your effective `kvMaxBytes` smaller than the number says. Decoding runs *before* your resolver sees a candidate, so resolvers still compare plaintext.

Full guide, including what iCloud and Drive already encrypt for you: [Encryption](encryption.md).

### Key validation

```ts
checkKey(key: string, providers: ProviderName[]): KeyRule | null
sanitizeKey(raw: string, maxBytes?: number): string
```

One key string has to be an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Drive filename at once, and the three disagree about what is legal. The store checks before the request and rejects with `ERR_INVALID_KEY`; without that, an illegal record name comes back as `BAD_REQUEST`, maps to `ERR_CONTAINER_MISCONFIGURED`, and sends you looking at your entitlements.

Every rule is scoped to the provider that imposes it, and is only checked when that provider is in your list. Rejecting a key for a restriction that cannot apply is a false alarm, and one that breaks working apps rather than pre-empting a server error.

| Rule | Applies when |
|---|---|
| Non-empty | always |
| ASCII letters, digits, `.`, `_`, `-` only | `cloudKit` / `cloudKitEncrypted` configured |
| No leading `_` (CloudKit reserves it) | `cloudKit` / `cloudKitEncrypted` configured |
| At most 255 characters | `cloudKit` / `cloudKitEncrypted` configured |
| At most 64 **UTF-8 bytes** | `icloudKV` configured |

So `auth/anonymousUserId/v1` is a perfectly good key for a key-value-store-only app - `NSUbiquitousKeyValueStore` keys are plain strings with no character rules, and Apple documents only the length. Add `cloudKit` to that store and the same key is rejected, because it now has to serve as a record name too.

`checkKey` returns `null` when the key is fine, or `{ reason, provider }` describing the first rule it breaks and which provider imposes it. `sanitizeKey` rewrites an arbitrary string into a legal one for keys that come from somewhere you do not control - a filename, a user-entered label. Over-long keys are truncated *and* suffixed with a hash of the original, because truncation alone maps every long key with a shared prefix onto the same short key and silently merges unrelated values.

Set `validateKeys: false` if your keys are known good and you would rather not pay for the check.

### Timeouts

`timeoutMs` bounds a single provider operation. React Native's `fetch` has no timeout of its own and neither does CloudKit's native stack, so an unanswered socket otherwise hangs forever - including `isAvailable()`, which the store calls before everything else. A timeout raises `ERR_TIMEOUT`, which is classified as retryable, so with the outbox on a hung write is queued rather than lost.

The REST clients have their own defaults independent of this: 30s for CloudKit, 60s for Drive (one "request" there can be an 8 MiB chunk). Both are configurable through `configureCloudKit` / `configureGoogleDrive`.

### Events

`onRemoteChange` and `onAccountChange` merge the events of every configured provider, so the facade - the recommended entry point - can be subscribed to directly instead of reaching for a raw provider.

The store also acts on account events itself. An `identityChanged: true` event drops memoised availability, tells every provider to `clearCaches()`, and **abandons the outbox**: a queued entry carries no account identity, so flushing after a switch would write the previous user's data into the new user's account.

Call `dispose()` when a store outlives its usefulness - it releases the provider subscriptions and stops auto-flush.

`writeMode` decides whether a write goes to the first available provider (`failover`, the default) or to all of them (`mirror`).

`resolve` changes how a read picks a value. Without it, `getItem` returns the first non-null value in provider order and stops - which silently serves stale data once both an Apple and a non-Apple device are writing. With it, every available provider is consulted and you choose the winner; the result is then written back to providers that disagreed unless `repairOnRead` is false. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).

`OutboxStorage` is **synchronous** - the outbox is read and written on the write path, so there is nowhere to await. An async store cannot be wrapped directly; use MMKV.

The default `outboxStorage` is in-memory, so queued writes do not survive a restart. Pass an MMKV-backed adapter in production - see [the outbox](store.md#making-it-durable).

## Tiering

```ts
interface TieringConfig {
  kvMaxBytes: number       // default 65536
  recordMaxBytes: number   // default 921600
}

const DEFAULT_TIERING: TieringConfig
```

Each threshold caps one provider: `kvMaxBytes` the key-value store, `recordMaxBytes` a CloudKit record field. A value above a provider's cap is routed past it to the next configured provider that is both large enough and available, and Google Drive stores whole files so it has no cap of its own. Binary assets are not part of tiering - see [`cloudKitAssets`](providers/cloudkit.md#assets).

## Resolvers

```ts
resolveByTimestamp(field = 'updatedAt'): ResolveFn
resolveByModifiedAt(options?: { fallback?: ResolveFn }): ResolveFn
resolveByPreferenceOrder: ResolveFn
resolveFirstOf(...resolvers: ResolveFn[]): ResolveFn
```

`resolveByTimestamp` reads a numeric or ISO-string timestamp out of each JSON candidate and takes the newest. A candidate it cannot date loses to one it can; if nothing is datable it falls back to provider order; ties keep the earlier provider so results do not flap.

`resolveByModifiedAt` orders on the **server's** modification time instead, which both CloudKit (`modified.timestamp`) and Drive (`modifiedTime`) already report and which this package now reads. That removes a real constraint: your values no longer have to be JSON carrying a field you remembered to update, so it works on plain strings and on payloads written before you thought about sync.

The catch, and why it is not the default: `NSUbiquitousKeyValueStore` exposes no per-key timestamp at all, so an `icloudKV` candidate never carries one. An undated candidate loses to any dated one; when *nothing* is dated the `fallback` decides (preference order unless you say otherwise).

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

`isCancelled` is separate from the other two on purpose: a cancelled operation is not a fault to report, and a UI that shows an error toast for one the user asked for is wrong.

`ErrorCode` is exported as a value, so branches and test fixtures can name a code instead of repeating the string:

```ts
import { ErrorCode } from 'react-native-cloud-sync'

ErrorCode.QUOTA_EXCEEDED   // 'ERR_QUOTA_EXCEEDED'
```

`CloudSyncErrorInfo` is the optional detail bag passed to the constructor - the type behind `retryAfterMs`, `limitBytes`, `actualBytes`, `serverValue`, `provider`, `serverErrorCode` and `cause`. Exported for anyone constructing a `CloudSyncError` in a custom provider.

Full code table: [Error handling](errors.md#codes).

## Base64

```ts
bytesToBase64(bytes: Uint8Array): string
base64ToBytes(base64: string): Uint8Array
```

The `GoogleDriveFileAdapter` contract is base64 in and base64 out, while modern filesystem APIs are byte-oriented - these bridge the two. Dependency-free and Hermes-safe, unlike `Buffer` or `atob`/`btoa`. See [the adapter](providers/google-drive.md#large-files).

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

`ProviderName` is an **open** union. `registerProvider` is documented as the way to plug in a provider you wrote yourself, and while this was a closed union of the four built-ins that was impossible to express in types - a `'dropbox'` provider needed a cast at every call site. The `string & {}` arm keeps autocomplete for the built-in names while accepting any other string; `BuiltInProviderName` is the closed set if you want it.

`ItemWithMeta` is what an optional `CloudProvider.getItemWithMeta` returns, and where `ResolveCandidate.modifiedAt` comes from. `QuotaInfo` is what `getQuota()` reports; `totalBytes` is absent for an unlimited or unreported quota, which is not the same as zero.

`AbortLike` is the abort-signal shape the cancellable APIs accept:

```ts
interface AbortLike {
  readonly aborted: boolean
  addEventListener: (type: 'abort', listener: () => void) => void
  removeEventListener: (type: 'abort', listener: () => void) => void
}
```

Structural rather than the DOM `AbortSignal`, so any polyfill satisfies it and you do not need `lib.dom` in your tsconfig. A real `AbortSignal` matches it.

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

Everything optional has a working fallback, so a minimal provider is six methods. Implement `multiGet`/`multiSet`/`multiRemove` only when your backend genuinely batches - a "batch" method that secretly loops hides N round trips behind a call that looks like one.

`clearCaches` matters more than its size suggests: the store calls it on an identity change, and anything you memoised belongs to the account that just left.

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

These exist because every app writes the same three of them, and each one has the same two bugs: a response that arrives after the key changed overwrites the newer one, and a `setState` after unmount. Both are handled once here.

`useCloudItem` writes optimistically and does *not* revert on error, because the store queues retryable failures - reverting would discard a value the outbox is still going to deliver. A failed read likewise leaves the last known value in place rather than blanking the screen on a network blip.

`useAccountStatus`'s `identityChanged` is **latched**, not momentary: it stays true once a different identity has signed in, so a screen that mounts just after the event still sees it.

## Diagnostics

```ts
setLogsEnabled(enabled: boolean): void
```

Off by default - a storage library logging every read is noise, and payloads can contain user data that should not reach a device log.
