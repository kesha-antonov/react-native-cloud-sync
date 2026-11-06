# React hooks

```ts
import { useCloudItem } from 'react-native-cloud-sync/hooks'
```

A separate entry point, so code outside React (sagas, background tasks) doesn't import it. The hooks handle the two usual bugs: a stale response overwriting a newer one, and `setState` after unmount.

## `useCloudItem`

Binds one key to component state.

```tsx
import { useCloudItem } from 'react-native-cloud-sync/hooks'

function SettingsScreen () {
  const { value, setValue, loading, error } = useCloudItem<Settings>(store, 'settings')

  if (loading) return <Spinner />
  if (error != null) return <SyncError code={error.code} />

  return <SettingsForm value={value} onChange={setValue} />
}
```

| | |
|---|---|
| `value` | Parsed value, or `null` when the key does not exist |
| `loading` | True until the first read settles, and during `refresh()` |
| `error` | Last read or write failure; cleared by the next success |
| `setValue` | Writes through, updating local state first |
| `remove` | Deletes the key |
| `refresh` | Re-reads |

Values go through `JSON.parse`/`JSON.stringify` by default. For a plain string, pass identity functions:

```ts
useCloudItem<string>(store, 'theme', {
  parse: raw => raw,
  serialize: value => value,
})
```

### It re-reads when another device writes

`watch` (default true) subscribes to [`onRemoteChange`](store.md#account-switches), so another device's edit shows up without a refresh. An event with an empty `keys` list (account or quota change) also triggers a re-read.

### Writes are optimistic and do not revert

`setValue` updates local state immediately and keeps it on failure, since the outbox usually delivers anyway. A failed read keeps the last known value.

### Stale responses cannot land

A read whose result is stale (key changed, overtaken, invalidated) is dropped instead of written into state. When `key` changes, `value` falls back to `initialValue` while the new key loads, never showing the old key's value.

## `useCloudItems`

Binds a list of keys with one batched `multiGet` instead of one `useCloudItem` per row. With `resolve` on the store, each key resolves as `getItem` would, including read repair. See [the cost](store.md#the-cost).

```tsx
function NotesList ({ noteIds }: { noteIds: string[] }) {
  const { values, setValue, loading } = useCloudItems<Note>(store, noteIds)

  if (loading) return <Spinner />

  return noteIds.map(id => (
    <NoteRow key={id} note={values[id]} onChange={next => setValue(id, next)} />
  ))
}
```

| | |
|---|---|
| `values` | Parsed value per key. A key mapped to `null` was fetched and doesn't exist; a key absent hasn't been fetched yet |
| `loading` | True only during the initial fetch of `keys`, and during `refresh()` |
| `error` | Last read or write failure; cleared by the next success |
| `setValue` | `(key, next) => Promise<void>` - writes through, updating local state first |
| `remove` | `(key) => Promise<void>` |
| `refresh` | Re-fetches every key currently tracked |

### It only fetches what it doesn't already know

Mount, `refresh()` and a matching remote-change event fetch. A key that merely joins the tracked list (say, `useCloudCollection` adding one after a local write) is not fetched, so a slow in-flight fetch can't overwrite the local write with a stale answer.

### Loading only reflects the initial fetch and `refresh()`

Remote events update `values` in the background without flipping `loading`, so live updates don't flash a spinner over visible rows.

## `useCloudCollection`

`useCloudItems` plus a live list of every key starting with `prefix`.

```tsx
function NotesList () {
  const { keys, values, setValue, remove } = useCloudCollection<Note>(store, 'note:')

  return keys.map(key => (
    <NoteRow key={key} note={values[key]} onChange={next => setValue(key, next)} onDelete={() => remove(key)} />
  ))
}
```

Returns the `useCloudItems` result plus `keys: string[]`. Re-lists on mount and after any remote-change event that could have added or removed a member.

`setValue` on a new key adds it to `keys` immediately, and `remove` drops it immediately. A listing already in flight can't undo either.

## `useAccountStatus`

```tsx
import { icloudKV } from 'react-native-cloud-sync'
import { useAccountStatus } from 'react-native-cloud-sync/hooks'

function SyncBanner () {
  const { status, identityChanged } = useAccountStatus(icloudKV)

  if (status === 'noAccount') return <SignInPrompt />
  if (identityChanged) return <SwitchedAccountNotice />
  return null
}
```

`status` is the provider's [`AccountStatus`](API.md#types), not a boolean, since signed out, temporarily unavailable and undetermined need different UI. `cloudKit` reports all five values; `icloudKV` only `available` or `noAccount` ([why](providers/icloud-kv.md#availability-and-account-state)). An account event arriving during a status query wins over the query's older answer.

`identityChanged` is **latched**: it stays true once a different identity signs in, so a screen mounting after the event still sees it.

## `usePendingWrites`

Drives a "pending sync" indicator.

```tsx
function PendingBadge () {
  const { pending, flush, discard } = usePendingWrites(store)

  if (pending.length === 0) return null

  return (
    <Row>
      <Text>{pending.length} waiting to sync</Text>
      <Button title="Retry now" onPress={flush} />
      <Button title="Discard" onPress={() => discard()} />
    </Row>
  )
}
```

Polls every 2s by default (cheap: `pendingWrites()` is a synchronous read). Pass `0` to read only on mount. Each entry has `lastErrorCode`, so the UI can say why it's stuck.

## `useRemoteChange`

```tsx
useRemoteChange(store, ({ keys }) => {
  for (const key of keys) queryClient.invalidateQueries([key])
})
```

The listener is held in a ref, so an inline function doesn't resubscribe every render.

## `useQuota`

```tsx
const { quota, loading, refresh } = useQuota(store)
```

Not polled (each read is a network round trip per provider). Call `refresh()` when a settings screen opens or after a large write.

## Cleaning up

No hook calls `store.dispose()`, since a store outlives its components. Call it yourself when done (sign-out, test teardown).
