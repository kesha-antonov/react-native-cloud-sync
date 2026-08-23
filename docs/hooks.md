# React hooks

```ts
import { useCloudItem } from 'react-native-cloud-sync/hooks'
```

A separate entry point: the store also runs in a saga, background task or plain module, none of which need a renderer.

Every app writes these same hooks and hits the same two bugs - a stale response overwriting a newer one, and `setState` after unmount - handled once here.

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

Values go through `JSON.parse`/`JSON.stringify` by default; for a plain string, pass identity functions:

```ts
useCloudItem<string>(store, 'theme', {
  parse: raw => raw,
  serialize: value => value,
})
```

### It re-reads when another device writes

`watch` defaults to true, subscribing to [`onRemoteChange`](store.md#account-switches) so another device's edit doesn't need a manual refresh to appear. An empty `keys` list (account or quota event) still triggers a re-read.

### Writes are optimistic and do not revert

`setValue` updates local state immediately and keeps it on failure, since the outbox usually delivers anyway. A failed *read* likewise keeps the last known value rather than blanking the screen over a network blip.

### Stale responses cannot land

Every read carries a ticket; a stale one - key changed, overtaken, invalidated - is dropped instead of written into state, avoiding a hand-rolled version's flash-of-wrong-value bug on fast navigation.

## `useCloudItems`

The multi-key sibling of `useCloudItem`. Binds a list of keys with one batched `multiGet` instead of one `useCloudItem` per row.

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

Mount, `refresh()`, and a matching remote-change event fetch normally. But a key that merely *joins* the tracked list - `useCloudCollection` adding one right after a local write, say - is never re-fetched on that account alone. Without that guard, a slow fetch already in flight for the rest of the list could land a stale answer on top of a write that already resolved locally, the same bug `useCloudItem`'s ticket exists to prevent, just triggered by list membership instead of a key change.

### Loading only reflects the initial fetch and `refresh()`

A remote event that adds a key to the list, or names a key already tracked, updates `values` in the background without flipping `loading` - a live update from another device shouldn't flash a spinner over rows that are already showing something.

## `useCloudCollection`

Adds the membership index `useCloudItems` needs but doesn't derive itself: every key starting with `prefix`, kept live.

```tsx
function NotesList () {
  const { keys, values, setValue, remove } = useCloudCollection<Note>(store, 'note:')

  return keys.map(key => (
    <NoteRow key={key} note={values[key]} onChange={next => setValue(key, next)} onDelete={() => remove(key)} />
  ))
}
```

Same shape as `useCloudItems`, plus `keys: string[]` for the current membership. Re-lists on mount and after any remote-change event that could plausibly have added or removed a member - not only one naming a key already under this prefix.

A `setValue` for a key not seen before joins `keys` immediately, so a newly created record appears in its own list without waiting on a round trip to confirm it. `remove` leaves the collection the same way.

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

All five [`AccountStatus`](errors.md) values, not a boolean - "signed out", "temporarily unavailable" and "could not determine" each need different UI.

`identityChanged` is **latched**: it stays true once a different identity signs in, so a screen mounting right after the event still sees it.

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

Polled every 2s by default, cheaply - `pendingWrites()` reads a small JSON blob synchronously. Pass `0` to poll only on mount.

Each entry carries `lastErrorCode`, so the indicator can say *why* it's stuck.

## `useRemoteChange`

```tsx
useRemoteChange(store, ({ keys }) => {
  for (const key of keys) queryClient.invalidateQueries([key])
})
```

The listener is held in a ref, so an inline arrow function doesn't rebuild the subscription every render.

## `useQuota`

```tsx
const { quota, loading, refresh } = useQuota(store)
```

Not polled - a per-provider network round trip, moving too slowly to watch. Call `refresh()` on settings-screen open, or after a large write.

## Cleaning up

None of these hooks call `store.dispose()` - a store outlives its components. Call it yourself when one is genuinely finished (sign-out, tearing down a test).
