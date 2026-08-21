# React hooks

```ts
import { useCloudItem } from 'react-native-cloud-sync/hooks'
```

A separate entry point: the store also runs in a saga, background task or plain module, none of which need a renderer.

Every app writes these same three hooks and hits the same two bugs - a stale response overwriting a newer one, and `setState` after unmount - handled once here.

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
