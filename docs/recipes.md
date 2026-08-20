# Recipes

Task-shaped answers that span providers.

## Assumed setup

Most recipes below pass an `mmkvAdapter` and write locally through `mmkv`. Both are this, defined once:

```ts
import { MMKV } from 'react-native-mmkv'

export const mmkv = new MMKV()

/** Makes the outbox survive a restart. See the outbox for why it matters. */
export const mmkvAdapter = {
  getString: (key: string) => mmkv.getString(key),
  set: (key: string, value: string) => mmkv.set(key, value),
}
```

MMKV because `outboxStorage` is read on the write path and so must be synchronous - see [making the outbox durable](store.md#making-it-durable).

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

Version the key (`backup/v1`) rather than the payload. When the shape changes, write `backup/v2` and keep reading v1 as a fallback - older devices keep working, and a rollback does not corrupt anything.

## Cross-platform large-file backup

That recipe is for a JSON-sized blob. For something too big to hold in memory as a string - a SQLite export, hundreds of MB - [`cloudKitBackup`](providers/cloudkit.md#backuprestore-helper) (iOS/macOS) and [`googleDriveFiles`](providers/google-drive.md#large-files) (Android/web) are the two providers that actually stream from disk instead of loading the whole file. They are not merged into one API because their restore paths genuinely differ - CloudKit invents its own temp path, Drive writes wherever you tell it to via your file adapter - but wrapping both behind one pair of functions is a few lines:

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
    return cloudKitBackup.restore({ onProgress: e => onProgress?.(e.fraction) })

  return googleDriveFiles.fetch({
    name: 'backup',
    destinationUri,
    onProgress: e => onProgress?.(e.fraction),
  })
}
```

On iOS/macOS, `restoreLargeFile`'s `destinationUri` is unused - `cloudKitBackup.restore` returns its own temp path, which is why the parameter is there at all: the caller decides where the file ends up, and on Apple platforms that decision is "wherever CloudKit already put it," while on Drive it is a real filesystem path from `configureGoogleDriveFiles`'s adapter. Move or copy the result into your app's own storage before relying on it living at that path long-term - CloudKit's temp location is not guaranteed to survive past the current run.

`googleDriveFiles` needs `configureGoogleDriveFiles` called once at startup (see [its setup](providers/google-drive.md#large-files)); `cloudKitBackup` needs nothing beyond the entitlements every other CloudKit call already requires.

## Restore safely on first launch

The failure mode to avoid is treating "the cloud errored" as "there is no backup" and then overwriting good remote data with an empty local state.

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

This is only safe because `null` means one thing. A signed-out user is the dangerous case - there is no error to catch, nothing is reachable, and a store that answered `null` there would send you straight into `startFresh()`. So the facade raises `ERR_NOT_SIGNED_IN` instead when **no** configured provider was reachable, and reserves `null` for "at least one provider answered and none of them had this key". See [absent vs broken](errors.md#distinguishing-absent-from-broken).

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

Checked between chunks, so it takes effect during the transfer rather than once the whole file has moved - which is the entire point at a few hundred megabytes.

CloudKit assets are cancelled by name instead, because that is what identifies a transfer everywhere else in that API:

```ts
await cloudKitBackup.cancel()                                  // the default backup
await cloudKitAssets.cancel({ recordName: 'avatar', fieldName: 'image' })
```

Both resolve `true` when there was something to cancel, and the cancelled call rejects with `ERR_CANCELLED`.

## Encrypt what goes to Drive

Drive's `appDataFolder` is hidden from the user's Drive UI, but it is plaintext to anything holding the account's OAuth token.

```ts
const store = createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: value => encryptWithDeviceKey(value),
    decode: value => decryptWithDeviceKey(value),
  },
})
```

The package ships no cipher of its own - key management is the part that decides whether this is worth anything, and bundling a cipher would make it look solved. Bring one you chose, and think about where its key lives (Keychain/Keystore, not the same cloud).

Values only, never keys - a `getAllKeys()` that returned ciphertext would be useless. Tiering measures the *encrypted* size, so an inflating codec eats into your thresholds.

On Apple platforms, `cloudKitEncrypted` gives you end-to-end encryption with no key to manage at all. [Encryption](encryption.md) covers which to pick.

## Last-write-wins with a timestamp

Neither CloudKit nor Drive merges for you. The simplest correct policy is to carry a timestamp and compare:

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

Note that deletions do not propagate under this scheme - a removed item reappears from whichever device still has it. If deletions matter, store tombstones rather than removing entries.

## Two-way sync between Apple and non-Apple devices

The setup for a fleet where any device might write - an Android phone and an
iPad, a browser and a Mac.

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

Every write must carry the timestamp, on every platform - a value the resolver
cannot date loses to one it can, so a device that forgets will always lose.

Clock skew is the limitation. Device clocks disagree, so "newest" means "claims
the latest timestamp". For a backup blob that is fine. For anything where a lost
write matters, merge in `resolve` rather than picking a winner:

```ts
resolve: candidates => JSON.stringify(
  mergeStates(candidates.map(c => JSON.parse(c.value) as Blob))
)
```

Deletions still need tombstones under either scheme - see
[last-write-wins](#last-write-wins-with-a-timestamp).

## Sync many keys at once

```ts
// One request per provider that batches, instead of one per key.
const pairs = await store.multiGet(['profile', 'settings', 'library'])
await store.multiSet(dirtyEntries)
```

Worth reaching for whenever you would have written a loop. On CloudKit this is the difference between one round trip and N - and between one rate-limit budget and N chances to be throttled, which is how a "sync everything on launch" screen ends up showing `ERR_RATE_LIMITED` to users with a lot of data.

## Drain the queue without wiring it yourself

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  outboxStorage: mmkvAdapter,
  autoFlush: true,          // on foreground, and every 60s while open
})
```

If you already have a NetInfo listener, keep calling `flushOutbox()` from it too - `autoFlush` is deliberately not network-aware, so that the package does not force a NetInfo dependency on everyone.

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

Requires `outboxStorage`, otherwise the queue is in-memory and empties on restart. See [the outbox](store.md#the-outbox).

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

Worth wiring even if you think you do not sync identity. Apps that store a user id in iCloud and skip this end up silently serving the previous user's data after a device changes hands.

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

That is the one-off, developer-initiated case. If the user is the one choosing where their data lives, see [Let the user choose their provider](#let-the-user-choose-their-provider), which wires the same call into a settings picker.

## Read legacy keys while writing new ones

When adopting this package over an existing store, read through the old path on a miss and lazily copy forward:

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

Keep the legacy read path for at least one release cycle after adoption. Users who skip a version otherwise lose whatever the old store held.

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

A settings picker: which cloud holds their data, or none. See [Choosing a provider](choosing-a-provider.md#better-still-let-the-user-choose) for why this is usually worth doing.

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

A store with no providers rejects every write with `ERR_NOT_SIGNED_IN` - the wrong thing to show someone who turned sync off deliberately, and not queued either, since that code counts as needing user action. So branch before calling rather than letting the store reject:

```ts
export async function save (key: string, value: string) {
  mmkv.set(key, value)             // local first, always
  if (choice === 'off') return     // sync is off; nothing more to do
  await store.setItem(key, value)
}
```

Turning sync off means "stop copying this to a cloud", not "stop saving my data" - so the local write stays unconditional.

### Or: one primary, plus an optional second copy

Instead of a single choice, offer a primary provider and a tick for mirroring to
another - which is what makes an Apple user's data reachable on Android. See
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

Persist the choice locally, and rebuild the store when it changes:

```ts
export function setChoice (next: Choice) {
  mmkv.set('sync/provider', next)
  store = buildStore(next)
}
```

### Switching between providers

Offer to bring the data along. `migrate` copies and leaves the source intact, so a failure cannot lose anything:

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

Two separate questions - stop syncing, and remove the existing copy. Ask them separately, because "stop backing up" and "delete my backup" are different intentions.

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

Order matters when the provider needs a session: **delete first, then disconnect.** Once the account is disconnected the deletes become silent no-ops, and the user is told their data is gone when it is not.

### Leftover data after a switch

If someone moves from iCloud to Drive, the iCloud copy is still there. Either offer to clean it up at the time, or remember the previous provider so the settings screen can offer it later:

```ts
const leftover = mmkv.getString('sync/previousProvider')
if (leftover != null && leftover !== 'off') {
  const provider = ALL.find(p => p.name === leftover)
  const stale = (await provider?.getAllKeys()) ?? []
  if (stale.length > 0) offerToDelete(leftover, stale.length)
}
```
