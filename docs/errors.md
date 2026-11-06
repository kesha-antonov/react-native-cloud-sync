# Error handling

Every failure is a typed rejection you can branch on. `null` means only "the key doesn't exist".

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
  e.serverErrorCode // the backend's own code, when there was one
  e.provider       // which provider raised it
}
```

## Codes

Codes map CloudKit's errors ([framework][ck], [Web Services][ckerrors]) and Drive's HTTP statuses; the original is kept on `serverErrorCode`. Per-provider details: [CloudKit](providers/cloudkit.md#errors-specific-to-cloudkit), [Google Drive](providers/google-drive.md#errors-specific-to-drive).

| Code | Meaning | Typical response |
|---|---|---|
| `ERR_NOT_SIGNED_IN` | No account signed in | Prompt sign-in |
| `ERR_ACCOUNT_RESTRICTED` | Parental controls or MDM | Explain; do not retry |
| `ERR_ACCOUNT_UNAVAILABLE` | `temporarilyUnavailable` | Retry silently later |
| `ERR_ACCOUNT_UNDETERMINED` | Status not yet known | Do nothing yet |
| `ERR_AUTH_EXPIRED` | Credential expired | Re-auth |
| `ERR_NETWORK_UNAVAILABLE` | Offline or unreachable | Queue and retry |
| `ERR_QUOTA_EXCEEDED` | Storage full | Tell the user |
| `ERR_RATE_LIMITED` | Backing off - including Drive's transient 5xx | Retry after `retryAfterMs` |
| `ERR_PAYLOAD_TOO_LARGE` | Above the store's limit | Use a bigger provider |
| `ERR_INVALID_KEY` | Key cannot round-trip through the configured providers, an invalid CloudKit identifier (name, zone, record type, field), or a record of another type under the requested name | Fix the key, or `sanitizeKey` it |
| `ERR_TIMEOUT` | Ran longer than the configured timeout | Retry; it may still be in flight |
| `ERR_CONFLICT` | Google Drive holds several files for one key and `onDuplicateName` is `'error'` | Remove the extra files, or use the default `'newest'` |
| `ERR_CONTAINER_MISCONFIGURED` | Entitlement, container, token or CloudKit permission (`ACCESS_DENIED`) problem | Fix the build or the Console |
| `ERR_UNSUPPORTED_PLATFORM` | Provider unavailable here | Branch on `isAvailable()` |
| `ERR_CANCELLED` | Cancelled by the caller | Nothing - they asked for it |
| `ERR_UNKNOWN` | Unclassified; `cause` holds the original. `serverErrorCode: 'UNTRUSTED_URL'` means a URL was refused: a Drive URL outside googleapis.com, or a non-HTTPS CloudKit asset URL | Report it |

Notes:

- `ERR_INVALID_KEY` fires **before** the request, instead of a confusing `BAD_REQUEST` (see [keys](store.md#keys)).
- `ERR_TIMEOUT` is an abandoned wait, not a failure.
- `ERR_CANCELLED` comes from [`cloudKitAssets.cancel`](providers/cloudkit.md#assets), `cloudKitBackup.cancel`, or an `AbortLike` signal passed to [`googleDriveFiles`](providers/google-drive.md#large-files).

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

Check `isCancelled` first: a cancellation isn't a fault. The [facade](store.md)'s outbox already queues retryable failures, so most call sites need only `requiresUserAction`.

## Recognising an error

```ts
import { isCloudSyncError } from 'react-native-cloud-sync'

if (isCloudSyncError(e)) console.warn(e.code)
```

Use the guard, not `instanceof`: bridge rejections can arrive as plain objects, so it checks shape.

## Distinguishing "absent" from "broken"

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

This works because the facade raises `ERR_NOT_SIGNED_IN`, never `null`, when no provider is reachable:

```ts
// One provider down, another up and holding the value -> the value.
// Every provider down -> ERR_NOT_SIGNED_IN, never null.
```

[ck]: https://developer.apple.com/documentation/cloudkit
[ckerrors]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ErrorCodes.html
