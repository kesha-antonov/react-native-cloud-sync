# Error handling

The reason this package exists. Every failure is a typed rejection you can branch on, and `null` means exactly one thing.

## The contract

```ts
const value = await icloudKV.getItem('k')
// null  ->  the key does not exist. Nothing else returns null.
```

Everything else rejects:

```ts
try {
  await store.setItem('k', 'v')
} catch (e) {
  e.code           // ErrorCode
  e.retryAfterMs   // on ERR_RATE_LIMITED
  e.limitBytes     // on ERR_PAYLOAD_TOO_LARGE
  e.actualBytes    // on ERR_PAYLOAD_TOO_LARGE
  e.serverValue    // on ERR_CONFLICT
  e.serverErrorCode // the backend's own code, when there was one
  e.provider       // which provider raised it
}
```

## Why it matters

A `catch { return null }` makes "not signed in", "offline", "out of storage" and "no such key" indistinguishable. The app then cannot tell the user anything useful, and cannot decide whether retrying is sensible.

Worse is a failed write reported as a success. Two libraries in this space do exactly that - one checks the wrong error variable in its completion block, the other discards the operation result - so a quota-exceeded write resolves happily and the data is gone.

## Codes

| Code | Meaning | Typical response |
|---|---|---|
| `ERR_NOT_SIGNED_IN` | No account signed in | Prompt sign-in |
| `ERR_ACCOUNT_RESTRICTED` | Parental controls or MDM | Explain; do not retry |
| `ERR_ACCOUNT_UNAVAILABLE` | `temporarilyUnavailable` | Retry silently later |
| `ERR_ACCOUNT_UNDETERMINED` | Status not yet known | Do nothing yet |
| `ERR_AUTH_EXPIRED` | Credential expired | Re-auth |
| `ERR_NETWORK_UNAVAILABLE` | Offline or unreachable | Queue and retry |
| `ERR_QUOTA_EXCEEDED` | Storage full | Tell the user |
| `ERR_RATE_LIMITED` | Backing off | Retry after `retryAfterMs` |
| `ERR_PAYLOAD_TOO_LARGE` | Above the store's limit | Use a bigger provider |
| `ERR_CONFLICT` | A concurrent write won | Merge using `serverValue` |
| `ERR_CONTAINER_MISCONFIGURED` | Entitlement, container or token problem | Fix the build |
| `ERR_UNSUPPORTED_PLATFORM` | Provider unavailable here | Branch on `isAvailable()` |
| `ERR_CANCELLED` | Cancelled by the caller | – |
| `ERR_UNKNOWN` | Unclassified; `cause` holds the original | Report it |

## Classifying without a switch

```ts
import { isRetryable, requiresUserAction } from '@kesha-antonov/react-native-cloud-sync'

try {
  await store.setItem('k', 'v')
} catch (e) {
  if (requiresUserAction(e)) promptUser(e.code)      // signed out, out of storage
  else if (isRetryable(e)) scheduleRetry(e.retryAfterMs)
  else report(e)
}
```

With the [facade](store.md) and the outbox enabled, retryable failures are already queued for you - so most call sites only need the `requiresUserAction` branch.

## Recognising an error

```ts
import { isCloudSyncError } from '@kesha-antonov/react-native-cloud-sync'

if (isCloudSyncError(e)) console.warn(e.code)
```

Use the guard rather than `instanceof`. A rejection crossing the React Native bridge arrives as a plain object on some paths, so the guard tests shape instead of identity.

## Distinguishing "absent" from "broken"

The one case worth being deliberate about:

```ts
let value: string | null = null
try {
  value = await store.getItem('portfolio')
} catch (e) {
  // Reached the cloud and something went wrong. Do NOT treat this as
  // "no backup exists" - that is how apps overwrite good remote data
  // with an empty local state.
  return showSyncError(e)
}

// Genuinely nothing stored yet, so seeding is safe.
if (value == null)
  seedInitialState()
```
