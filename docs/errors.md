# Error handling

Every failure here is a typed rejection you can branch on; `null` means exactly one thing.

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

A `catch { return null }` conflates every failure into one useless signal. Worse, a failed write can look like success: real libraries misreport it, so a quota-exceeded write resolves happily while the data vanishes.

## Codes

These codes map onto CloudKit's own ([framework][ck], [Web Services][ckerrors]) and Drive's HTTP statuses; the original is kept on `serverErrorCode`.

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
| `ERR_INVALID_KEY` | Key cannot round-trip through the configured providers | Fix the key, or `sanitizeKey` it |
| `ERR_TIMEOUT` | Ran longer than the configured timeout | Retry; it may still be in flight |
| `ERR_CONFLICT` | A concurrent write won | Merge using `serverValue` |
| `ERR_CONTAINER_MISCONFIGURED` | Entitlement, container or token problem | Fix the build |
| `ERR_UNSUPPORTED_PLATFORM` | Provider unavailable here | Branch on `isAvailable()` |
| `ERR_CANCELLED` | Cancelled by the caller | Nothing - they asked for it |
| `ERR_UNKNOWN` | Unclassified; `cause` holds the original | Report it |

Three deserve a note: `ERR_INVALID_KEY` fires **before** the request, so a bad record name doesn't instead surface as a confusing `BAD_REQUEST` (see [keys](store.md#keys)); `ERR_TIMEOUT` is only an abandoned wait, not a failure; and `ERR_CANCELLED` is what a cancelled transfer rejects with - [`cloudKitAssets.cancel`](providers/cloudkit.md#assets), `cloudKitBackup.cancel`, or an `AbortLike` signal to [`googleDriveFiles`](providers/google-drive.md#large-files).

## Classifying without a switch

```ts
import { isCancelled, isRetryable, requiresUserAction } from 'react-native-cloud-sync'

try {
  await store.setItem('k', 'v')
} catch (e) {
  if (isCancelled(e)) return                          // they asked; say nothing
  if (requiresUserAction(e)) promptUser(e.code)       // signed out, out of storage
  else if (isRetryable(e)) scheduleRetry(e.retryAfterMs)
  else report(e)
}
```

`isCancelled` comes first: cancelling isn't a fault, so don't toast it. The [facade](store.md)'s outbox already queues retryable failures, so most call sites need only `requiresUserAction`.

## Recognising an error

```ts
import { isCloudSyncError } from 'react-native-cloud-sync'

if (isCloudSyncError(e)) console.warn(e.code)
```

Use the guard, not `instanceof`: a bridge rejection sometimes arrives as a plain object, so it checks shape.

## Distinguishing "absent" from "broken"

The one case worth being deliberate about:

```ts
let value: string | null = null
try {
  value = await store.getItem('playlist')
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

That works because the facade raises `ERR_NOT_SIGNED_IN`, never `null`, when no provider is reachable - and the reverse holds too:

```ts
// One provider down, another up and holding the value -> the value.
// Every provider down -> ERR_NOT_SIGNED_IN, never null.
```

[ck]: https://developer.apple.com/documentation/cloudkit
[ckerrors]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ErrorCodes.html
