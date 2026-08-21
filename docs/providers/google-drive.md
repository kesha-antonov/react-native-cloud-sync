# Google Drive

Drive's hidden [`appDataFolder`][appdata] - a per-app, per-Google-account folder that never appears in the user's visible Drive.

## When to use it

Always-on backend for a cross-platform app - identical on iOS, Android and web, with no periodic re-auth unlike CloudKit's Android path.

| | |
|---|---|
| Platforms | iOS, Android, web |
| Auth | OAuth, [`drive.appdata` scope][drivescopes], supplied by your app |
| Size limits | the user's Drive quota |
| Survives app uninstall | yes - tied to the account, not the install; gone only on Drive disconnect or direct deletion |
| Remote change events | – |
| Visible to the user in Drive | no |

## Setup

This package never owns the consent flow - you supply a token getter, independent of any sign-in library, so the same code runs in a browser too.

```ts
import { configureGoogleDrive } from 'react-native-cloud-sync'

configureGoogleDrive({
  getAccessToken: async () => (await GoogleSignin.getTokens()).accessToken,
  onAuthExpired: () => reconnectDrive(),
})
```

`getAccessToken` is called before every request - refresh silently there rather than caching a token that may have expired.

With `@react-native-google-signin/google-signin`, the one-time connect:

```ts
GoogleSignin.configure({
  scopes: ['https://www.googleapis.com/auth/drive.appdata'],
  webClientId: WEB_CLIENT_ID,
  iosClientId: IOS_CLIENT_ID,
})

await GoogleSignin.hasPlayServices()
await GoogleSignin.signIn()          // account picker + consent, once
```

Afterwards, `signInSilently()` keeps every read and write silent.

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

`setItem` holds the whole value in memory as a JS string - fine for JSON, not a 500 MB database export - so `googleDriveFiles` (the Android/web equivalent of `cloudKitAssets`' `CKAsset`) uploads via Drive's resumable protocol in fixed chunks (8 MiB default, never more than one in memory), retrying a dropped chunk from the real server offset instead of restarting the whole upload.

No filesystem dependency here, so both directions read/write through a `GoogleDriveFileAdapter` you supply - a few lines wrapping whichever fs library you already use:

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

`File`/`FileHandle`/seekable `offset` are the modern `expo-file-system` API (SDK 54); `FileHandle` reads/writes at an arbitrary offset so a chunk never costs more than its own bytes - close it in a `finally`, since an open handle blocks the file from being moved or deleted. `readBytes`/`writeBytes` use `Uint8Array` while the adapter contract is base64, so this package exports [`bytesToBase64`/`base64ToBytes`](../API.md#base64) to bridge them, dependency-free and Hermes-safe unlike `Buffer` or `atob`/`btoa`.

(`react-native-fs` fits this shape too, but has had no commits in two years and 600+ open issues; `expo-file-system` also works in a bare RN project.)

A working version - adapter, upload, download, progress - is the **Files** tab of the [example app](https://github.com/kesha-antonov/react-native-cloud-sync/blob/main/example).

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

Calling `save`/`fetch` before `configureGoogleDriveFiles` rejects with `ERR_CONTAINER_MISCONFIGURED`, naming the missing call - separate from `configureGoogleDrive` since most apps never touch a file this large.

Resumability covers a dropped connection for free (a chunk that fails mid-flight retries against Drive's real offset). Surviving the *process* dying mid-upload needs one more thing - pass `sessionStore` to `configureGoogleDrive`:

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

Without it, a killed process restarts `save` from byte 0; with it, `save` persists the session first, and the next call for the same `name` - even a fresh process - finds it, asks Drive for the real offset, and resumes. A session is trusted only if the source size still matches (a changed size starts fresh, since a byte-range upload into different content would corrupt it), and one Drive no longer recognizes (past its ~1 week lifetime) is handled the same way, transparently. It's a tiny JSON record, not file I/O, so `sessionStore` is a much lighter ask than `GoogleDriveFileAdapter` - one row in whatever key-value storage the host app already has. Cancelling via `signal` drops the session too, since a deliberate stop isn't a crash to recover from.

If losing a transfer to backgrounding or an OS kill is the failure you care about, [`@kesha-antonov/react-native-background-downloader`][rnbd] is built for it: `createUploadTask`/`createDownloadTask` hand the whole transfer to `NSURLSession`/a foreground service, re-attachable via `getExistingUploadTasks`/`getExistingDownloadTasks`. It doesn't implement `GoogleDriveFileAdapter` (whole-file HTTP tasks, not byte-range), so using it means driving Drive's plain, non-resumable `uploadType=media`/`alt=media` endpoints directly - trading Drive's resumable protocol for the OS's background-session resilience.

CloudKit-native equivalent on iOS/macOS: [assets](cloudkit.md#assets), [backup/restore](cloudkit.md#backuprestore-helper); [Recipes](../recipes.md#cross-platform-large-file-backup) pairs the two behind one function.

[rnbd]: https://www.npmjs.com/package/@kesha-antonov/react-native-background-downloader

## Availability

```ts
// False when not configured, or when no token is available.
if (!(await googleDrive.isAvailable()))
  promptConnect()
```

`isAvailable()` only checks that a token can be obtained - no network request, so it's safe on a render path.

## What happens on a reinstall

The **file** survives - it belongs to the Google account. The **session** doesn't: a fresh install needs one more tap to connect, after which `getItem` immediately reads the previous data back.

## Performance notes

The [Drive `files` API][drivefiles] has no "get by name" endpoint, so a read must first resolve a name to a file id - this package does that with one scoped `q=` query and caches the id, keeping a read to a single request and usually none.

The naive approach - listing every file and filtering client-side - is what makes other implementations take minutes on accounts with many files; if you switch accounts, drop the cache by reconfiguring.

## Errors specific to Drive

| Code | Cause |
|---|---|
| `ERR_NOT_SIGNED_IN` | `getAccessToken` returned null |
| `ERR_AUTH_EXPIRED` | HTTP 401, or a 403 whose body doesn't match one of the reasons below; `onAuthExpired` fires |
| `ERR_RATE_LIMITED` | HTTP 429, or a 403 with `reason: userRateLimitExceeded`/`rateLimitExceeded`; `retryAfterMs` set from `Retry-After` when present (only the plain-429 case carries it) |
| `ERR_QUOTA_EXCEEDED` | A 403 with `reason: storageQuotaExceeded` - the user's Drive is full, never the 507 a WebDAV-style API would use |

See [Error handling](../errors.md).

[appdata]: https://developers.google.com/workspace/drive/api/guides/appdata
[drivescopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[drivefiles]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files

## Knowing when another device wrote

Drive has no push channel a mobile client can subscribe to (its webhooks need a public HTTPS endpoint), so `onRemoteChange` polls Drive's change cursor instead:

```ts
const off = googleDrive.onRemoteChange(({ keys }) => reload(keys))
```

Polling starts with the first subscriber and stops with the last, so an app that never subscribes never makes the request - default interval is 30s (`changePollIntervalMs` on `createGoogleDriveProvider`), and an empty poll is still just one request.

Deletions are included too - the client drops its memoised file id for anything the feed reports removed, so a stale id can't keep answering reads.

The first tick only establishes the starting cursor, so a new subscriber isn't told everything that ever happened just changed.

## Storage usage

```ts
const [drive] = await store.getQuota()
// { provider: 'googleDrive', usedBytes: 4_100_000_000, totalBytes: 15_000_000_000 }
```

This is the whole Google account's usage, not the `appDataFolder`'s share (Drive reports no per-folder figure) - it's the number that matters anyway, since the account limit is what a write actually hits.

`totalBytes` is absent for a pooled or unlimited Workspace account - not zero, and an "out of space" prompt that treats it as zero is worse than no prompt.

## Cancelling a transfer

```ts
const controller = new AbortController()

await googleDriveFiles.save({
  name: 'backup.sqlite',
  fileUri: localPath,
  signal: controller.signal,
})
```

Checked between chunks, so a cancel lands during the transfer rather than after; bytes Drive already accepted stay in the resumable session, and a later `save` of the same name starts a fresh one.

`signal` is typed structurally, so a polyfilled `AbortController` works and you don't need `lib.dom` in your tsconfig.
