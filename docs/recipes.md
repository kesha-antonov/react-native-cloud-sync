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

if (remote == null || local.updatedAt > remote.updatedAt) {
  await store.setItem(KEY, JSON.stringify(local))
} else if (remote.updatedAt > local.updatedAt) {
  applyRemote(remote.data)
}
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
      if (s === 'active') {
        store.flushOutbox().then(tick).catch(() => undefined)
      }
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

## Choose a provider at runtime

```ts
const available = await Promise.all([
  icloudKV.isAvailable(),
  googleDrive.isAvailable(),
])

// isAvailable never throws, so this is safe on a render path.
const providers = [
  available[0] && 'icloudKV',
  available[1] && 'googleDrive',
].filter(Boolean) as ProviderName[]
```
