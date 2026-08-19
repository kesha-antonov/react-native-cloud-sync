# Google Drive

Drive's hidden `appDataFolder` - a per-app, per-Google-account folder that never appears in the user's visible Drive.

## When to use it

The always-on backend for a cross-platform app. It behaves identically on iOS, Android and web, and unlike CloudKit's Android path it needs no periodic re-auth.

| | |
|---|---|
| Platforms | iOS, Android, web |
| Auth | OAuth, `drive.appdata` scope, supplied by your app |
| Size limits | the user's Drive quota |
| Survives app uninstall | yes - tied to the account, not the install |
| Remote change events | – |
| Visible to the user in Drive | no |

## Setup

This package never owns the consent flow. You supply a token getter, which keeps it independent of any particular sign-in library and lets the same code run in a browser.

```ts
import { configureGoogleDrive } from '@kesha-antonov/react-native-cloud-sync'

configureGoogleDrive({
  getAccessToken: async () => (await GoogleSignin.getTokens()).accessToken,
  onAuthExpired: () => reconnectDrive(),
})
```

`getAccessToken` is called before every request, so refresh silently there rather than caching a token that may have expired.

With `@react-native-google-signin/google-signin`, the one-time connect looks like:

```ts
GoogleSignin.configure({
  scopes: ['https://www.googleapis.com/auth/drive.appdata'],
  webClientId: WEB_CLIENT_ID,
  iosClientId: IOS_CLIENT_ID,
})

await GoogleSignin.hasPlayServices()
await GoogleSignin.signIn()          // account picker + consent, once
```

Afterwards `signInSilently()` keeps every read and write silent.

## Operations

```ts
import { googleDrive } from '@kesha-antonov/react-native-cloud-sync'

await googleDrive.setItem('portfolio.json', JSON.stringify(holdings))

const raw = await googleDrive.getItem('portfolio.json')
// null means no such file.

await googleDrive.removeItem('portfolio.json')

const names = await googleDrive.getAllKeys()   // paginated internally
```

Keys are file names inside `appDataFolder`.

## Availability

```ts
// False when not configured, or when no token is available.
if (!(await googleDrive.isAvailable()))
  promptConnect()
```

`isAvailable()` only checks that a token can be obtained; it makes no network request, so it is safe on a render path.

## What happens on a reinstall

The **file** survives - it belongs to the Google account. The **session** does not: on a fresh install the user must tap connect once more, after which the previous data is immediately readable again. Call `getItem` right after a successful connect to pull it back.

## Performance notes

Drive has no "get by name" endpoint, so a read has to resolve a name to a file id first. This package issues one scoped `q=` query and then caches the id, which keeps a read to a single request and usually none.

The naive approach - list every file in the drive and filter client-side - is what makes other implementations take minutes on accounts with many files. If you switch accounts, drop the cache by reconfiguring.

## Errors specific to Drive

| Code | Cause |
|---|---|
| `ERR_NOT_SIGNED_IN` | `getAccessToken` returned null |
| `ERR_AUTH_EXPIRED` | Drive rejected the token (HTTP 401/403); `onAuthExpired` fires |
| `ERR_RATE_LIMITED` | HTTP 429; `retryAfterMs` set from the `Retry-After` header |
| `ERR_QUOTA_EXCEEDED` | HTTP 507 - the user's Drive is full |

See [Error handling](../errors.md).

## No change events

Drive has no push channel here, so `onRemoteChange` is not implemented. If you need another device's write to arrive without user action, either pair Drive with `icloudKV`/`cloudKit` through the [facade](../store.md), or re-read on app foreground.
