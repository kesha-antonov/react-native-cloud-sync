# iCloud key-value store

[`NSUbiquitousKeyValueStore`][kvs] - a small dictionary that syncs across a user's Apple devices with no sign-in and no UI.

## When to use it

Small, non-critical values that follow the user across devices - theme, units, onboarding flags, a device-independent user id - and the only provider working from a cold start with no user prompt.

Not for the app's primary data: capped at 1 MB *in total*, and exceeding that starves every other key.

| | |
|---|---|
| Platforms | iOS, macOS (including Mac Catalyst) |
| Auth | implicit - the device's iCloud account |
| Total size | 1 MB |
| Per key | 1 MB |
| Max keys | 1024 |
| Remote change events | yes |
| Account change events | yes |

## Setup

Entitlements only - no code configuration. See [Platform Notes](../PLATFORM_NOTES.md#entitlements) for the exact keys, or use the Expo config plugin.

## Operations

```ts
import { icloudKV } from 'react-native-cloud-sync'

await icloudKV.setItem('settings/theme', 'dark')

const theme = await icloudKV.getItem('settings/theme')
// null means the key does not exist. Nothing else returns null.

await icloudKV.removeItem('settings/theme')

const keys = await icloudKV.getAllKeys()
```

Every failure rejects with a typed error - see [Error handling](../errors.md).

## Availability and account state

```ts
// False when not signed in, restricted, or not on an Apple platform.
if (!(await icloudKV.isAvailable()))
  return

const status = await icloudKV.getAccountStatus()
// 'available' | 'noAccount'
```

On Apple platforms the status comes from `ubiquityIdentityToken`, not CloudKit - so it is safe in an app with only the key-value-store entitlement, but it reports only `available` or `noAccount` (restricted reads as `noAccount`). The five-state [`CKAccountStatus`][ckstatus] belongs to [`cloudKit`](cloudkit.md#availability-and-account-state).

Off Apple platforms `getAccountStatus()` resolves `couldNotDetermine` rather than throwing - a status question has a truthful answer everywhere.

## Reacting to other devices

```ts
const unsubscribe = icloudKV.onRemoteChange(({ keys, reason }) => {
  // reason: serverChange | initialSync | quotaViolation | accountChange
  reload(keys)
})
```

`quotaViolation` is worth handling explicitly - it means the 1 MB budget is full and writes are being dropped.

## Reacting to an Apple ID switch

```ts
icloudKV.onAccountChange(({ status, identityChanged }) => {
  // A DIFFERENT Apple ID is now signed in, so anything cached for the previous
  // user is now wrong.
  if (identityChanged)
    clearUserScopedCaches()
})
```

The event most apps miss - without it, a device that switches Apple ID keeps silently serving the previous user's data.

## `sync()` does not mean "stored"

```ts
import { icloudKVSync } from 'react-native-cloud-sync'

await icloudKVSync()
```

Maps to `NSUbiquitousKeyValueStore.synchronize()`: flushes pending changes to disk and schedules an upload, but does **not** wait for or confirm a server round trip - a resolved promise means *queued*, never *stored in iCloud*. Writes schedule themselves, so you rarely need to call it.

## Limits are enforced, not discovered

A value above 1 MB rejects locally with `ERR_PAYLOAD_TOO_LARGE`, carrying `limitBytes` and `actualBytes`, rather than being handed to the OS and silently dropped. The same goes for a write that would push the store past its 1 MB total, which rejects with `ERR_QUOTA_EXCEEDED` - counting keys as well as values, as Apple does.

Hitting the limit is the signal to move that key to `cloudKit`/`googleDrive` - or let the [facade](../store.md) route it for you.

## On Android and web

Every data operation rejects with `ERR_UNSUPPORTED_PLATFORM` - a rejected promise, so `.catch` handles it, not a synchronous throw - with no polyfill and no fallback, since `NSUbiquitousKeyValueStore` has no network API to reach. `isAvailable()` resolves false and `getAccountStatus()` resolves `couldNotDetermine`. Use `cloudKit` for the same account's data elsewhere, or `googleDrive`.

[kvs]: https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore
[ckstatus]: https://developer.apple.com/documentation/cloudkit/ckaccountstatus
