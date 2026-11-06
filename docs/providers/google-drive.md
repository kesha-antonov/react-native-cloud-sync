# Google Drive

Drive's hidden [`appDataFolder`][appdata]: a per-app, per-Google-account folder that never appears in the user's visible Drive.

## When to use it

An always-on backend for a cross-platform app. It behaves the same on iOS, Android and web, and unlike CloudKit's Android path it needs no periodic re-auth.

| | |
|---|---|
| Platforms | iOS, Android, web |
| Auth | OAuth, [`drive.appdata` scope][drivescopes], supplied by your app |
| Size limits | the user's Drive quota |
| Survives app uninstall | yes; tied to the account, gone only on Drive disconnect or direct deletion |
| Remote change events | polled (see [below](#knowing-when-another-device-wrote)) |
| Visible to the user in Drive | no |

## Setup

You own the consent flow and supply a token getter. It works with any sign-in library, and in a browser.

```ts
import { configureGoogleDrive } from 'react-native-cloud-sync'

configureGoogleDrive({
  getAccessToken: async () => (await GoogleSignin.getTokens()).accessToken,
  onAuthExpired: () => reconnectDrive(),
})
```

`getAccessToken` runs before every request. Refresh silently there instead of caching a token that may expire.

The one-time connect with `@react-native-google-signin/google-signin`:

```ts
GoogleSignin.configure({
  scopes: ['https://www.googleapis.com/auth/drive.appdata'],
  webClientId: WEB_CLIENT_ID,
  iosClientId: IOS_CLIENT_ID,
})

await GoogleSignin.hasPlayServices()
await GoogleSignin.signIn()          // account picker + consent, once
```

After that, `signInSilently()` keeps reads and writes silent.

## Operations

```ts
import { googleDrive } from 'react-native-cloud-sync'

await googleDrive.setItem('playlist.json', JSON.stringify(tracks))

const raw = await googleDrive.getItem('playlist.json')
// null means no such file.

await googleDrive.removeItem('playlist.json')

const names = await googleDrive.getAllKeys()   // paginated internally
```

Keys are file names inside `appDataFolder`.

## Large files

`setItem` holds the whole value in memory as a string: fine for JSON, not for a 500 MB database. `googleDriveFiles` (the Android/web counterpart of `cloudKitAssets`) uses Drive's resumable upload:

- fixed chunks, 8 MiB by default, at most one in memory
- a dropped chunk retries from the server's real offset instead of restarting the upload

The package has no filesystem dependency, so you supply a `GoogleDriveFileAdapter` that wraps your fs library:

```ts
import {
  base64ToBytes,
  bytesToBase64,
  configureGoogleDriveFiles,
} from 'react-native-cloud-sync'
import { File } from 'expo-file-system'

configureGoogleDriveFiles({
  statSize: async uri => new File(uri).size,

  readChunk: async (uri, position, length) => {
    const handle = new File(uri).open()
    try {
      handle.offset = position
      return bytesToBase64(handle.readBytes(length))
    }
    finally {
      handle.close()
    }
  },

  writeChunk: async (uri, base64) => {
    const file = new File(uri)
    file.create({ intermediates: true, overwrite: true })
    const handle = file.open()
    try {
      handle.writeBytes(base64ToBytes(base64))
    }
    finally {
      handle.close()
    }
  },

  appendChunk: async (uri, base64) => {
    const handle = new File(uri).open()
    try {
      handle.offset = handle.size ?? 0
      handle.writeBytes(base64ToBytes(base64))
    }
    finally {
      handle.close()
    }
  },
})
```

Notes on this adapter:

- It uses the `expo-file-system` `File`/`FileHandle` API (SDK 54), which also works in a bare RN project. `FileHandle` reads and writes at any offset, so a chunk costs only its own bytes.
- Close the handle in `finally`; an open handle blocks the file from being moved or deleted.
- `readBytes`/`writeBytes` use `Uint8Array` and the adapter contract is base64. [`bytesToBase64`/`base64ToBytes`](../API.md#base64) convert between them without dependencies and are Hermes-safe (`Buffer` and `atob`/`btoa` are not).
- `react-native-fs` also fits, but has had no commits in two years and 600+ open issues.

A working version (adapter, upload, download, progress) is in the **Files** tab of the [example app](https://github.com/kesha-antonov/react-native-cloud-sync/blob/main/example).

Then:

```ts
import { googleDriveFiles } from 'react-native-cloud-sync'

await googleDriveFiles.save({
  name: 'backup.db',
  fileUri: dbPath,
  onProgress: ({ fraction }) => setUploadProgress(fraction),
})

const restoredPath = await googleDriveFiles.fetch({
  name: 'backup.db',
  destinationUri: `${documentsDir}/restored.db`,
  onProgress: ({ fraction }) => setDownloadProgress(fraction),
})
// null when nothing has been saved under that name yet - destinationUri is
// never touched in that case
```

Calling `save`/`fetch` before `configureGoogleDriveFiles` rejects with `ERR_CONTAINER_MISCONFIGURED`, naming the missing call. It is separate from `configureGoogleDrive` because most apps never move files this large.

### Resuming after the app is killed

A dropped connection resumes automatically. To also resume after the process dies, pass `sessionStore` to `configureGoogleDrive`:

```ts
import { configureGoogleDrive } from 'react-native-cloud-sync'

configureGoogleDrive({
  getAccessToken: () => secureStore.get('driveAccessToken'),
  sessionStore: {
    get: name => AsyncStorage.getItem(`drive-session:${name}`).then(v => v ? JSON.parse(v) : null),
    set: (name, session) => AsyncStorage.setItem(`drive-session:${name}`, JSON.stringify(session)),
    remove: name => AsyncStorage.removeItem(`drive-session:${name}`),
  },
})
```

How it behaves:

- Without it, a killed process restarts `save` from byte 0. With it, `save` persists the session first, and the next `save` for the same `name` (even in a new process) asks Drive for the real offset and resumes.
- A session is reused only if the source file size still matches. A changed size, or a session Drive no longer recognizes (they last about a week), starts fresh.
- A session is a small JSON record; any key-value storage you already have will do.
- Cancelling via `signal` drops the session, since a deliberate stop is not a crash.
- A stored `sessionUrl` must be on `https://www.googleapis.com/` or `https://<host>.googleapis.com/upload/`. Anything else (for example a tampered entry) is ignored and a fresh session starts, so the access token is never sent elsewhere.

If your concern is losing transfers to backgrounding or an OS kill, consider [`@kesha-antonov/react-native-background-downloader`][rnbd]. Its `createUploadTask`/`createDownloadTask` hand the transfer to `NSURLSession` or a foreground service, and `getExistingUploadTasks`/`getExistingDownloadTasks` re-attach to it. It does whole-file HTTP, not byte ranges, so it cannot implement `GoogleDriveFileAdapter`; you would call Drive's non-resumable `uploadType=media`/`alt=media` endpoints directly.

CloudKit equivalents on iOS/macOS: [assets](cloudkit.md#assets), [backup/restore](cloudkit.md#backuprestore-helper). [Recipes](../recipes.md#cross-platform-large-file-backup) wraps both behind one function.

[rnbd]: https://www.npmjs.com/package/@kesha-antonov/react-native-background-downloader

## Availability

```ts
// False when not configured, or when no token is available.
if (!(await googleDrive.isAvailable()))
  promptConnect()
```

`isAvailable()` only checks that a token can be obtained. It makes no network request, so it is safe on a render path.

## What happens on a reinstall

The files survive; they belong to the Google account. The session does not: after a reinstall the user taps to connect once, and `getItem` reads the previous data.

## Performance notes

The [Drive `files` API][drivefiles] has no get-by-name endpoint, so a read resolves the name to a file id first. This package does that with one scoped `q=` query and caches the id, so a read is usually one request. (Listing every file and filtering client-side is what makes some implementations take minutes on large accounts.) If you switch accounts, reconfigure to drop the cache.

- `getItemWithMeta` (used by [`resolveByModifiedAt`](../store.md#resolve)) always re-lists the name, since a cached `modifiedTime` goes stale as soon as another device writes. That is one request more than `getItem`.
- There is no `multiGet`: Drive has no batch endpoint for file content, and a fake batch would hide N round trips.
- `multiGetWithMeta` exists because it does save requests: one listing per 50 keys instead of one per key, plus one download per key.

## Errors specific to Drive

| Code | Cause |
|---|---|
| `ERR_NOT_SIGNED_IN` | `getAccessToken` returned null |
| `ERR_AUTH_EXPIRED` | HTTP 401, or a 403 whose body doesn't match one of the reasons below; `onAuthExpired` fires |
| `ERR_RATE_LIMITED` | HTTP 429, or a 403 with `reason: userRateLimitExceeded`/`rateLimitExceeded`; `retryAfterMs` set from `Retry-After` when present, at most 1 hour (the 403 variants never carry it) |
| `ERR_RATE_LIMITED` | HTTP 500/502/503/504, which Google documents as transient; `serverErrorCode` is `HTTP_503` and so on, and `retryAfterMs` comes from `Retry-After` when sent |
| `ERR_QUOTA_EXCEEDED` | A 403 with `reason: storageQuotaExceeded`: the user's Drive is full (Drive does not use 507) |
| `ERR_UNKNOWN` | `serverErrorCode: 'UNTRUSTED_URL'`: a request or resumable session URI outside `https://www.googleapis.com` (or `https://<host>.googleapis.com/upload/`); refused before the token is attached |

See [Error handling](../errors.md).

[appdata]: https://developers.google.com/workspace/drive/api/guides/appdata
[drivescopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[drivefiles]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files

## Knowing when another device wrote

Drive's webhooks need a public HTTPS endpoint, so a mobile client cannot subscribe. `onRemoteChange` polls Drive's change cursor instead:

```ts
const off = googleDrive.onRemoteChange(({ keys }) => reload(keys))
```

- Polling runs only while there are subscribers. The default interval is 30s (`changePollIntervalMs` on `createGoogleDriveProvider`); an empty poll is one request.
- Deletions are reported too. Every name in the feed (removed, changed, or a same-named copy from another device) drops its cached file id, so the next read re-lists it.
- The starting cursor is taken when the first listener subscribes, so no write in between is missed. The first poll reports nothing, so a new subscriber is not flooded with history.
- After an account switch (`clearCaches()`), polling restarts on a fresh cursor for existing listeners.

## Storage usage

```ts
const [drive] = await store.getQuota()
// { provider: 'googleDrive', usedBytes: 4_100_000_000, totalBytes: 15_000_000_000 }
```

This is the whole Google account's usage, not the `appDataFolder` share (Drive has no per-folder figure). The account limit is what a write hits anyway.

`totalBytes` is absent, not zero, for pooled or unlimited Workspace accounts. Do not show an "out of space" prompt that treats it as zero.

## Cancelling a transfer

```ts
const controller = new AbortController()

await googleDriveFiles.save({
  name: 'backup.sqlite',
  fileUri: localPath,
  signal: controller.signal,
})
```

The signal is checked between chunks, so a cancel takes effect mid-transfer. A later `save` of the same name starts a fresh session.

`signal` is typed structurally: a polyfilled `AbortController` works and you do not need `lib.dom` in your tsconfig.
