# iCloud key-value store

[`NSUbiquitousKeyValueStore`][kvs]: a small dictionary that syncs across a user's Apple devices with no sign-in and no UI.

## When to use it

Small, non-critical values that should follow the user: theme, units, onboarding flags, a device-independent user id. It is the only provider that works from a cold start with no prompt.

Not for primary data. The store is capped at 1 MB in total, and filling it starves every other key.

| | |
|---|---|
| Platforms | iOS, macOS (including Mac Catalyst) |
| Auth | implicit, the device's iCloud account |
| Total size | 1 MB |
| Per key | 1 MB |
| Max keys | 1024 |
| Remote change events | yes |
| Account change events | yes |

## Setup

Entitlements only, no code. See [Platform Notes](../PLATFORM_NOTES.md#entitlements) for the keys, or use the Expo config plugin.

## Operations

```ts
import { icloudKV } from 'react-native-cloud-sync'

await icloudKV.setItem('settings/theme', 'dark')

const theme = await icloudKV.getItem('settings/theme')
// null means the key does not exist. Nothing else returns null.

await icloudKV.removeItem('settings/theme')

const keys = await icloudKV.getAllKeys()
```

Every failure rejects with a typed error. See [Error handling](../errors.md).

## Availability and account state

```ts
// False when not signed in, restricted, or not on an Apple platform.
if (!(await icloudKV.isAvailable()))
  return

const status = await icloudKV.getAccountStatus()
// 'available' | 'noAccount'
```

The status comes from `ubiquityIdentityToken`, not CloudKit, so it is safe in an app that has only the key-value-store entitlement. It reports only `available` or `noAccount` (restricted reads as `noAccount`). For the five-state [`CKAccountStatus`][ckstatus], use [`cloudKit`](cloudkit.md#availability-and-account-state).

Off Apple platforms, `getAccountStatus()` resolves `couldNotDetermine` instead of throwing.

## Reacting to other devices

```ts
const unsubscribe = icloudKV.onRemoteChange(({ keys, reason }) => {
  // reason: serverChange | initialSync | quotaViolation | accountChange
  reload(keys)
})
```

Handle `quotaViolation`: the 1 MB budget is full and writes are being dropped.

## Reacting to an Apple ID switch

```ts
icloudKV.onAccountChange(({ status, identityChanged }) => {
  // A DIFFERENT Apple ID is now signed in, so anything cached for the previous
  // user is now wrong.
  if (identityChanged)
    clearUserScopedCaches()
})
```

Without this, a device that switches Apple ID keeps serving the previous user's data.

## `sync()` does not mean "stored"

```ts
import { icloudKVSync } from 'react-native-cloud-sync'

await icloudKVSync()
```

Maps to `NSUbiquitousKeyValueStore.synchronize()`. It flushes pending changes to disk and schedules an upload, but does not wait for the server. A resolved promise means queued, not stored in iCloud. Writes schedule themselves, so you rarely need it.

## Limits are enforced, not discovered

Limits are checked locally instead of letting the OS drop the write silently:

- a value above 1 MB rejects with `ERR_PAYLOAD_TOO_LARGE`, carrying `limitBytes` and `actualBytes`
- a write that would push the store past 1 MB total rejects with `ERR_QUOTA_EXCEEDED` (keys count toward the total, as Apple counts them)

When you hit a limit, move that key to `cloudKit` or `googleDrive`, or let the [facade](../store.md) route it.

## On Android and web

Every data operation rejects with `ERR_UNSUPPORTED_PLATFORM` (a rejected promise, not a synchronous throw). There is no fallback: `NSUbiquitousKeyValueStore` has no network API. `isAvailable()` resolves false and `getAccountStatus()` resolves `couldNotDetermine`. Use `cloudKit` to reach the same account elsewhere, or `googleDrive`.

[kvs]: https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore
[ckstatus]: https://developer.apple.com/documentation/cloudkit/ckaccountstatus
