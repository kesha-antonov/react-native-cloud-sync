# Recipes

Task-shaped answers that span providers.

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

## Restore safely on first launch

The failure mode to avoid is treating "the cloud errored" as "there is no backup" and then overwriting good remote data with an empty local state.

```ts
let remote: string | null
try {
  remote = await store.getItem(KEY)
} catch (e) {
  // Reached the cloud and it failed. Do NOT seed, do NOT overwrite.
  return startWithLocalState({ syncError: e })
}

if (remote == null) startFresh()   // genuinely nothing stored
else applyRemote(JSON.parse(remote))
```

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
} from '@kesha-antonov/react-native-cloud-sync'

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
