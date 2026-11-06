# Recipes

Task-focused examples that span providers.

## Assumed setup

Most recipes use `mmkvAdapter` and `mmkv`, defined once:

```ts
import { MMKV } from 'react-native-mmkv'

export const mmkv = new MMKV()

/** Makes the outbox survive a restart. See the outbox for why it matters. */
export const mmkvAdapter = {
  getString: (key: string) => mmkv.getString(key),
  set: (key: string, value: string) => mmkv.set(key, value),
}
```

`outboxStorage` is read on the write path, so it must be synchronous; MMKV is. See [making the outbox durable](store.md#making-it-durable).

## Back up and restore user data

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  tiering: 'auto',
  outboxStorage: mmkvAdapter,
})

const KEY = 'backup/v1'

export async function backup (state: AppState) {
  await store.setItem(KEY, JSON.stringify({ ...state, updatedAt: Date.now() }))
}

export async function restore (): Promise<AppState | null> {
  const raw = await store.getItem(KEY)
  return raw == null ? null : (JSON.parse(raw) as AppState)
}
```

Version the key (`backup/v1`), not the payload. When the shape changes, write `backup/v2` and fall back to reading v1. Older devices keep working, and a rollback cannot corrupt anything.

## Let the user download their backup

An export the user can save to Files, AirDrop, or email to support. Useful for any data the user considers theirs: a finance database, a journal, a workout history.

Three steps; this package handles the first two:

1. **Download the file** to a path you control.
2. **Put it somewhere durable**, not the temporary directory.
3. **Hand it to the system** so the user picks the destination.

```ts
import * as FileSystem from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { cloudKitBackup, googleDriveFiles } from 'react-native-cloud-sync'

async function exportBackup () {
  const stamp = new Date().toISOString().slice(0, 10)
  const destinationUri = `${FileSystem.documentDirectory}finance-backup-${stamp}.sqlite`

  const path = Platform.OS === 'ios'
    ? await cloudKitBackup.restore({ destinationUri, onProgress: track })
    : await googleDriveFiles.fetch({ name: 'backup.sqlite', destinationUri, onProgress: track })

  if (path == null) return showNothingToExport()

  await Sharing.shareAsync(path, {
    mimeType: 'application/x-sqlite3',
    dialogTitle: 'Export backup',
  })
}
```

### Always pass `destinationUri`

Without it, `cloudKitBackup.restore()` puts the file in the app's temporary directory under a name derived from the record. Fine for restoring into the app; wrong for an export, because iOS may delete it at any time and the name is not user-friendly.

Use `documentDirectory`: it persists, is backed up, and the share sheet can read it. Parent directories are created for you.

### The sharing step is not ours

`expo-sharing`, `react-native-share` and `expo-document-picker` already handle the share sheet, "Save to Files" and the import picker. This package stops at giving you a real path.

On iOS you can skip the share sheet: [`icloudDocuments`](providers/icloud-drive.md) puts the file straight into the user's iCloud Drive, visible in Files.app.

```ts
await icloudDocuments.save({ fileUri: path, name: `finance-backup-${stamp}.sqlite` })
```

### Exporting is a privacy decision

Once a file leaves your sandbox, none of this package's guarantees apply. Data protected by [`cloudKitEncrypted`](encryption.md#cloudkits-native-encryption) or a `codec` is **plaintext on disk** as soon as you write it where the share sheet can reach it.

For sensitive data such as a finance app's, encrypt the export with a passphrase entered at export time, and tell the user plainly if they decline that the file is unencrypted. See [Encryption](encryption.md#where-the-key-lives) for where that key should live.

### Importing it back

Build import at the same time; an export nobody can restore is useless:

```ts
const picked = await DocumentPicker.getDocumentAsync({ type: 'application/x-sqlite3' })
if (picked.canceled) return

await validateBackupFile(picked.assets[0].uri)     // yours: check it is really your schema
await restoreFromFile(picked.assets[0].uri)
```

Validate before restoring: the file came from outside your app, may be from a much older version, or may not be yours at all.

### Large databases

Both fetch paths stream and never hold the whole database in memory: `googleDriveFiles` downloads in 8 MiB chunks through the file adapter, `cloudKitBackup` streams a `CKAsset` from disk. Show progress (a large export with no feedback looks like a hang) and offer a cancel:

```ts
await cloudKitBackup.cancel()                        // rejects the restore with ERR_CANCELLED
```

## Cross-platform large-file backup

[Back up and restore](#back-up-and-restore-user-data) suits JSON-sized data. For files too big to hold in memory as a string (a SQLite export, hundreds of MB), use the two APIs that stream from disk: [`cloudKitBackup`](providers/cloudkit.md#backuprestore-helper) on iOS/macOS and [`googleDriveFiles`](providers/google-drive.md#large-files) on Android/web. One pair of functions covers both:

```ts
import { Platform } from 'react-native'
import { cloudKitBackup, googleDriveFiles } from 'react-native-cloud-sync'

const isAppleNative = Platform.OS === 'ios' || Platform.OS === 'macos'

export async function backupLargeFile (
  fileUri: string,
  onProgress?: (fraction: number) => void
) {
  if (isAppleNative)
    await cloudKitBackup.save(fileUri, { onProgress: e => onProgress?.(e.fraction) })
  else
    await googleDriveFiles.save({
      name: 'backup',
      fileUri,
      onProgress: e => onProgress?.(e.fraction),
    })
}

export async function restoreLargeFile (
  destinationUri: string,
  onProgress?: (fraction: number) => void
): Promise<string | null> {
  if (isAppleNative)
    return cloudKitBackup.restore({ destinationUri, onProgress: e => onProgress?.(e.fraction) })

  return googleDriveFiles.fetch({
    name: 'backup',
    destinationUri,
    onProgress: e => onProgress?.(e.fraction),
  })
}
```

Pass a durable `destinationUri` on both platforms. Without one, `cloudKitBackup.restore` writes to the temporary directory, which iOS may clear.

`googleDriveFiles` needs `configureGoogleDriveFiles` called once at startup (see [its setup](providers/google-drive.md#large-files)). `cloudKitBackup` needs only the usual CloudKit entitlements and [schema](providers/cloudkit.md#the-schema).

## Restore safely on first launch

Never treat "the cloud errored" as "there is no backup"; that overwrites good remote data with an empty local state.

```ts
let remote: string | null
try {
  remote = await store.getItem(KEY)
} catch (e) {
  // Reached the cloud and it failed, OR could not reach it at all. Either way:
  // do NOT seed, do NOT overwrite.
  return startWithLocalState({ syncError: e })
}

if (remote == null) startFresh()   // genuinely nothing stored
else applyRemote(JSON.parse(remote))
```

This works because `null` has one meaning. If **no** provider is reachable (for example, the user is signed out), the facade raises `ERR_NOT_SIGNED_IN` instead of returning `null`. `null` means at least one provider answered and none had the key. See [absent vs broken](errors.md#distinguishing-absent-from-broken).

## Cancel a large transfer

```ts
const controller = new AbortController()

showCancelButton(() => controller.abort())

try {
  await googleDriveFiles.save({
    name: 'backup.sqlite',
    fileUri: localPath,
    signal: controller.signal,
    onProgress: ({ fraction }) => setProgress(fraction),
  })
} catch (e) {
  if (isCancelled(e)) return   // they asked. Say nothing.
  throw e
}
```

The signal is checked between chunks, so it takes effect mid-transfer.

CloudKit transfers are cancelled by record and field, which is how that API identifies them:

```ts
await cloudKitBackup.cancel()                                  // the default backup
await cloudKitAssets.cancel({ recordName: 'avatar', fieldName: 'image' })
```

Both resolve `true` when there was something to cancel; the cancelled call rejects with `ERR_CANCELLED`.

## Encrypt what goes to Drive

Drive's `appDataFolder` is hidden from the user, but plaintext to anything holding the account's OAuth token.

```ts
const store = createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: value => encryptWithDeviceKey(value),
    decode: value => decryptWithDeviceKey(value),
  },
})
```

The package ships no cipher; bring your own. Key storage decides whether this protects anything: keep the key in the Keychain/Keystore, not in the same cloud.

Only values are encrypted, never keys. Tiering measures the encrypted size, so an inflating codec lowers your effective thresholds.

On Apple platforms, `cloudKitEncrypted` is end-to-end encrypted with no key to manage. See [Encryption](encryption.md) to choose.

## Last-write-wins with a timestamp

Neither CloudKit nor Drive merges for you. The simplest correct policy is a timestamp comparison:

```ts
interface Blob { data: AppState, updatedAt: number }

const remoteRaw = await store.getItem(KEY)
const remote = remoteRaw == null ? null : (JSON.parse(remoteRaw) as Blob)

if (remote == null || local.updatedAt > remote.updatedAt)
  await store.setItem(KEY, JSON.stringify(local))
else if (remote.updatedAt > local.updatedAt)
  applyRemote(remote.data)
// Equal timestamps: nothing to do.
```

Deletions do not propagate: a removed item comes back from any device that still has it. If deletions matter, store tombstones instead of removing entries.

## Two-way sync between Apple and non-Apple devices

```ts
import {
  createCloudStore,
  resolveByTimestamp,
} from 'react-native-cloud-sync'

interface Blob { data: AppState, updatedAt: number }

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  // Put a copy in Drive, so a non-Apple device has something to read.
  writeMode: 'mirror',
  // Consult both, and take the newest - otherwise an Apple device returns its
  // own stale iCloud copy without ever looking at Drive.
  resolve: resolveByTimestamp('updatedAt'),
  outboxStorage: mmkvAdapter,
})

export async function save (data: AppState) {
  const blob: Blob = { data, updatedAt: Date.now() }
  await store.setItem('state/v1', JSON.stringify(blob))
}

export async function load (): Promise<AppState | null> {
  const raw = await store.getItem('state/v1')
  return raw == null ? null : (JSON.parse(raw) as Blob).data
}
```

Every write on every platform must carry the timestamp. A value the resolver
cannot date always loses to one it can.

Device clocks disagree, so "newest" means "claims the latest timestamp". That is
fine for a backup blob. Where a lost write matters, merge in `resolve` instead of
picking a winner:

```ts
resolve: candidates => JSON.stringify(
  mergeStates(candidates.map(c => JSON.parse(c.value) as Blob))
)
```

Deletions still need tombstones; see
[last-write-wins](#last-write-wins-with-a-timestamp).

## Sync many keys at once

```ts
// One request per provider that batches, instead of one per key.
const pairs = await store.multiGet(['profile', 'settings', 'library'])
await store.multiSet(dirtyEntries)
```

On CloudKit this is one round trip instead of N, and one rate-limit hit instead of N. Looping per key is how a "sync everything on launch" screen ends up with `ERR_RATE_LIMITED` for users with a lot of data.

## Drain the queue without wiring it yourself

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  outboxStorage: mmkvAdapter,
  autoFlush: true,          // on foreground, and every 60s while open
})
```

`autoFlush` does not watch the network, to avoid a NetInfo dependency. If you have a NetInfo listener, call `flushOutbox()` from it too.

## Show a "pending sync" indicator

```ts
function SyncBadge () {
  const [pending, setPending] = useState(0)

  useEffect(() => {
    const tick = () => setPending(store.pendingWrites().length)
    tick()
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active')
        store.flushOutbox().then(tick).catch(() => undefined)
    })
    return () => sub.remove()
  }, [])

  return pending > 0 ? <Badge count={pending} /> : null
}
```

Requires `outboxStorage`; otherwise the queue is in memory and empties on restart. See [the outbox](store.md#the-outbox).

## Handle an Apple ID switch

```ts
icloudKV.onAccountChange(({ identityChanged }) => {
  if (!identityChanged) return

  // A different person is signed in. Anything derived from the previous
  // account is now wrong - including any "logged in" state you inferred
  // from a value that came out of iCloud.
  clearUserScopedCaches()
  reloadFromCloud()
})
```

Wire this even if you think you do not sync identity. Without it, an app that stores a user id in iCloud serves the previous user's data after the device changes hands.

## Migrate a user from iCloud to Drive

```ts
const { copied } = await store.migrate({ from: 'icloudKV', to: 'googleDrive' })

// Verify before removing anything.
for (const key of copied) {
  const there = await googleDrive.getItem(key)
  if (there == null) throw new Error(`migration incomplete: ${key}`)
}
```

`migrate` copies and leaves the source intact, so a partial failure cannot lose data.

To let the user choose where their data lives, see [Let the user choose their provider](#let-the-user-choose-their-provider).

## Read legacy keys while writing new ones

When replacing an existing store, fall back to the old store on a miss and copy the value forward:

```ts
async function getWithLegacy (key: string): Promise<string | null> {
  const current = await store.getItem(key)
  if (current != null) return current

  const legacy = await legacyStore.get(key)
  if (legacy == null) return null

  // Fire and forget - a failed copy just means we try again next read.
  store.setItem(key, legacy).catch(() => undefined)
  return legacy
}
```

Keep the legacy read path for at least one release cycle, or users who skip a version lose what the old store held.

## Offline-first writes

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  outbox: true,
  outboxStorage: mmkvAdapter,
  onError: e => log.warn('queued', e.code),
})

// Always write locally first; the cloud is the copy, not the source of truth.
mmkv.set(KEY, json)
await store.setItem(KEY, json)   // queued if offline

// Drain on reconnect.
NetInfo.addEventListener(s => {
  if (s.isConnected) store.flushOutbox().catch(() => undefined)
})
```

## Let the user choose their provider

A settings picker for which cloud holds the user's data, or none. See [Choosing a provider](choosing-a-provider.md#better-still-let-the-user-choose) for why.

```ts
import {
  cloudKit,
  googleDrive,
  icloudKV,
  createCloudStore,
  type CloudProvider,
  type ProviderName,
} from 'react-native-cloud-sync'

type Choice = ProviderName | 'off'

const ALL: CloudProvider[] = [icloudKV, cloudKit, googleDrive]

/** Only what actually works on this device - never offer a dead option. */
export async function availableProviders (): Promise<ProviderName[]> {
  const checked = await Promise.all(
    ALL.map(async p => [p.name, await p.isAvailable()] as const)
  )
  return checked.filter(([, ok]) => ok).map(([name]) => name)
}

export function buildStore (choice: Choice) {
  return createCloudStore({
    providers: choice === 'off' ? [] : [choice],
    tiering: 'auto',
    outboxStorage: mmkvAdapter,
  })
}
```

A store with no providers rejects every write with `ERR_NOT_SIGNED_IN` and does not queue it. That is the wrong message for someone who turned sync off, so branch before calling:

```ts
export async function save (key: string, value: string) {
  mmkv.set(key, value)             // local first, always
  if (choice === 'off') return     // sync is off; nothing more to do
  await store.setItem(key, value)
}
```

Turning sync off means "stop copying to a cloud", not "stop saving my data", so the local write stays unconditional.

### Or: one primary, plus an optional second copy

Offer a primary provider plus a checkbox to mirror to Drive, which makes an
Apple user's data reachable on Android. See
[Also back up to Google Drive](choosing-a-provider.md#also-back-up-to-google-drive).

```ts
export function buildMirroredStore (primary: ProviderName, alsoDrive: boolean) {
  return createCloudStore({
    providers: alsoDrive ? [primary, 'googleDrive'] : [primary],
    writeMode: alsoDrive ? 'mirror' : 'failover',
    tiering: 'auto',
    outboxStorage: mmkvAdapter,
  })
}

/** Enabling only mirrors FUTURE writes - copy what already exists, once. */
export async function enableDriveMirror (primary: ProviderName) {
  const store = buildMirroredStore(primary, true)
  await store.migrate({ from: primary, to: 'googleDrive' })
  return store
}
```

Persist the choice locally and rebuild the store when it changes:

```ts
export function setChoice (next: Choice) {
  mmkv.set('sync/provider', next)
  store = buildStore(next)
}
```

### Switching between providers

`migrate` leaves the source intact, so a failed switch loses nothing:

```ts
export async function switchProvider (from: Choice, to: Choice) {
  if (from !== 'off' && to !== 'off') {
    const combined = createCloudStore({ providers: [from, to] })
    await combined.migrate({ from, to })
  }
  setChoice(to)
}
```

### Turning it off, and deleting what is stored

Ask separately: "stop backing up" and "delete my backup" are different requests.

```ts
export async function turnOff (previous: Choice, alsoDelete: boolean) {
  if (alsoDelete && previous !== 'off')
    await deleteEverything(previous)
  setChoice('off')
}

/**
 * Deletes every key this app ever wrote - enumerated, not hardcoded.
 *
 * Hardcoding a list is how a "delete my backup" flow ends up removing the two
 * keys someone remembered and quietly leaving the rest behind. If the user
 * asked you to delete their data, delete it.
 */
async function deleteEverything (name: ProviderName) {
  const provider = ALL.find(p => p.name === name)
  if (provider == null) return

  const keys = await provider.getAllKeys()
  const failed: string[] = []

  for (const key of keys)
    try {
      await provider.removeItem(key)
    }
    catch {
      failed.push(key)
    }

  // Report honestly rather than claiming success.
  if (failed.length > 0)
    throw new Error(`Could not delete ${failed.length} of ${keys.length} items`)
}
```

When the provider needs a session, **delete first, then disconnect.** After disconnecting, deletes are silent no-ops and the user is told their data is gone when it is not.

### Leftover data after a switch

After a move from iCloud to Drive, the iCloud copy remains. Offer to delete it at the time, or remember the previous provider and offer it later:

```ts
const leftover = mmkv.getString('sync/previousProvider')
if (leftover != null && leftover !== 'off') {
  const provider = ALL.find(p => p.name === leftover)
  const stale = (await provider?.getAllKeys()) ?? []
  if (stale.length > 0) offerToDelete(leftover, stale.length)
}
```
