# React hooks

```ts
import { useCloudItem } from 'react-native-cloud-sync/hooks'
```

A separate entry point on purpose. The store is usable from a saga, a background task or a plain module, and none of those should have to pull in a renderer.

These exist because every app ends up writing the same three of them, and each hand-rolled version has the same two bugs: a response that arrives after the key changed overwrites the newer one, and a `setState` after unmount. Both are handled once here.

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

`watch` defaults to true, which subscribes to [`onRemoteChange`](store.md#account-switches). Without it a screen shows whatever it read when it mounted, and the other device's edit appears only after a manual pull-to-refresh - which is most of the reason to be on a sync library at all.

An event with an empty `keys` list (an account or quota event, where the provider could not say what changed) triggers a re-read rather than being assumed irrelevant.

### Writes are optimistic and do not revert

`setValue` updates local state before the write resolves, and leaves it there if the write rejects. That is deliberate: the store queues retryable failures, so the write usually lands eventually - reverting would discard a value the outbox is still going to deliver, and show the user their edit disappearing for no reason they can see.

A failed *read* likewise leaves the last known value in place. A network blip is not evidence the key is gone, and blanking the screen is worse than showing stale data next to an error.

### Stale responses cannot land

Every read takes a ticket. A response whose ticket is no longer current - because the key changed, or a refresh overtook it, or a write invalidated it - is dropped instead of being written into state. This is the bug that makes a hand-rolled version show another key's value for a frame when you navigate quickly.

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

All five [`AccountStatus`](errors.md) values, not a boolean - "signed out", "temporarily unavailable" and "could not determine" call for three different things on screen.

`identityChanged` is **latched**: once a different identity has signed in it stays true, so a screen that mounts just after the event still sees it. A momentary flag would be missed by everything not already rendered.

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

Polled, at 2s by default, because there is no event to subscribe to - entries are added from whichever call site failed rather than from one place that could emit. It is cheap: `pendingWrites()` is a synchronous read of a small JSON blob, not a network call. Pass `0` to poll only on mount.

Each entry carries `lastErrorCode`, so the indicator can say *why* something is stuck rather than only that it is.

## `useRemoteChange`

```tsx
useRemoteChange(store, ({ keys }) => {
  for (const key of keys) queryClient.invalidateQueries([key])
})
```

The listener is held in a ref, so passing an inline arrow function does not tear down and rebuild the subscription on every render.

## `useQuota`

```tsx
const { quota, loading, refresh } = useQuota(store)
```

Not polled - `getQuota` is a network round trip per provider, and a number that moves this slowly does not need watching. Call `refresh()` when a settings screen opens, or after a large write.

## Cleaning up

None of these hooks call `store.dispose()`, because a store usually outlives the components using it. Call it yourself when a store is genuinely finished - on sign-out, or when tearing down a test.
