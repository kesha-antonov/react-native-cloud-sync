# Google Drive

Drive's hidden [`appDataFolder`][appdata] - a per-app, per-Google-account folder that never appears in the user's visible Drive.

## When to use it

The always-on backend for a cross-platform app. It behaves identically on iOS, Android and web, and unlike CloudKit's Android path it needs no periodic re-auth.

| | |
|---|---|
| Platforms | iOS, Android, web |
| Auth | OAuth, [`drive.appdata` scope][drivescopes], supplied by your app |
| Size limits | the user's Drive quota |
| Survives app uninstall | yes - tied to the account, not the install; gone only if the user disconnects the app from Drive or deletes the data folder directly |
| Remote change events | – |
| Visible to the user in Drive | no |

## Setup

This package never owns the consent flow. You supply a token getter, which keeps it independent of any particular sign-in library and lets the same code run in a browser.

```ts
import { configureGoogleDrive } from 'react-native-cloud-sync'

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
import { googleDrive } from 'react-native-cloud-sync'

await googleDrive.setItem('playlist.json', JSON.stringify(tracks))

const raw = await googleDrive.getItem('playlist.json')
// null means no such file.

await googleDrive.removeItem('playlist.json')

const names = await googleDrive.getAllKeys()   // paginated internally
```

Keys are file names inside `appDataFolder`.

## Large files

`setItem` holds the whole value in memory as a JS string, which is fine for JSON but not for a 500 MB database export. `googleDriveFiles` is the Android/web equivalent of `cloudKitAssets`' `CKAsset`: it uploads with Drive's resumable protocol and reads the source file in fixed chunks (8 MiB by default), so it never holds more than one chunk in memory, and a chunk that drops mid-transfer is retried from the real server offset rather than restarting the whole upload. Downloads write in the same fixed chunks.

This package has no filesystem dependency, so both directions read/write through a `GoogleDriveFileAdapter` you supply - a few lines wrapping whichever fs library you already use:

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

`File`, `FileHandle` and the seekable `offset` are the modern `expo-file-system` API, introduced in SDK 54. A `FileHandle` is the part that matters here: it reads and writes at an arbitrary offset, so a chunk never costs more than its own bytes. Close it in a `finally` - an open handle blocks the file from being moved or deleted.

`readBytes`/`writeBytes` work in `Uint8Array` while the adapter contract is base64, so this package exports [`bytesToBase64`/`base64ToBytes`](../API.md#base64) to bridge them. They are dependency-free and Hermes-safe, unlike `Buffer` or `atob`/`btoa`.

(`react-native-fs` also fits this shape, but it has had no commits in over two years and 600+ open issues - not a bet worth making for something a 500 MB restore depends on. `expo-file-system` works in a bare React Native project too, without the rest of Expo.)

A working end-to-end version of this - adapter, upload, download, progress - is the **Files** tab of the [example app](https://github.com/kesha-antonov/react-native-cloud-sync/blob/main/example).

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

Calling `save`/`fetch` before `configureGoogleDriveFiles` rejects with `ERR_CONTAINER_MISCONFIGURED`, naming the missing call - separate from `configureGoogleDrive` because most apps never touch a file this large and shouldn't need to think about filesystem access to use the text/JSON path.

Resumability covers a dropped connection for free: a chunk that fails mid-flight is retried against Drive's real offset rather than restarting the whole transfer. Surviving the *process* dying mid-upload needs one more thing - pass `sessionStore` to `configureGoogleDrive`:

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

Without it, the session lives only in memory, and a process that dies mid-upload has to restart `save` from byte 0 on the next call - exactly as before. With it, `save` persists the session before the first chunk goes out, and the next call for the same `name` - even from a fresh process - finds it, asks Drive for the real offset, and resumes from there.

A persisted session is only ever trusted when it still matches the source file's size; a size that has changed since means the session is dropped and a fresh one started, since resuming a byte-range upload into different content would corrupt it. A session Drive no longer recognises (past its ~1 week server-side lifetime, say) is handled the same way - transparently, not as an error. It's a tiny JSON record, not file I/O, so `sessionStore` is a much lighter ask than `GoogleDriveFileAdapter`: one row in whatever key-value storage the host app already has.

Cancelling via `signal` drops the persisted session rather than leaving it - a deliberate stop is not a crash to recover from.

If losing a transfer to the app being backgrounded or killed mid-way is the failure you actually care about, that is a different problem than the one `googleDriveFiles` solves, and [`@kesha-antonov/react-native-background-downloader`][rnbd] is built for exactly it - `createUploadTask`/`createDownloadTask` hand the whole transfer to `NSURLSession`/a foreground service, so it keeps running (and can be re-attached to via `getExistingUploadTasks`/`getExistingDownloadTasks`) even after the OS terminates the app. It does not implement `GoogleDriveFileAdapter` - it works in whole-file HTTP tasks, not the byte-range chunk reads/writes the adapter contract needs - so using it means going around `googleDriveFiles` and driving Drive's plain (non-resumable) `uploadType=media`/`alt=media` endpoints directly with it, trading Drive's own resumable protocol for the OS's background-session resilience instead.

For the CloudKit-native equivalent on iOS/macOS, see [assets](cloudkit.md#assets) and [the backup/restore helper](cloudkit.md#backuprestore-helper); [Recipes](../recipes.md#cross-platform-large-file-backup) shows the two paired behind one function.

[rnbd]: https://www.npmjs.com/package/@kesha-antonov/react-native-background-downloader

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

The [Drive `files` API][drivefiles] has no "get by name" endpoint, so a read has to resolve a name to a file id first. This package issues one scoped `q=` query and then caches the id, which keeps a read to a single request and usually none.

The naive approach - list every file in the drive and filter client-side - is what makes other implementations take minutes on accounts with many files. If you switch accounts, drop the cache by reconfiguring.

## Errors specific to Drive

| Code | Cause |
|---|---|
| `ERR_NOT_SIGNED_IN` | `getAccessToken` returned null |
| `ERR_AUTH_EXPIRED` | HTTP 401, or a 403 whose body doesn't match one of the reasons below; `onAuthExpired` fires |
| `ERR_RATE_LIMITED` | HTTP 429, or a 403 with `reason: userRateLimitExceeded`/`rateLimitExceeded`; `retryAfterMs` set from `Retry-After` when present (only the plain-429 case carries it) |
| `ERR_QUOTA_EXCEEDED` | A 403 with `reason: storageQuotaExceeded` - the user's Drive is full. Drive never uses 507 for this, despite it looking like the natural WebDAV-style status |

See [Error handling](../errors.md).

## No change events

Drive has no push channel here, so `onRemoteChange` is not implemented. If you need another device's write to arrive without user action, either pair Drive with `icloudKV`/`cloudKit` through the [facade](../store.md), or re-read on app foreground.

[appdata]: https://developers.google.com/workspace/drive/api/guides/appdata
[drivescopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[drivefiles]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files

## Knowing when another device wrote

Drive has no push channel a mobile client can subscribe to - its webhooks need a public HTTPS endpoint to deliver to - so `onRemoteChange` polls Drive's change cursor instead:

```ts
const off = googleDrive.onRemoteChange(({ keys }) => reload(keys))
```

Polling starts with the first subscriber and stops with the last, so an app that never subscribes never makes the request. The interval is 30s by default (`changePollIntervalMs` on `createGoogleDriveProvider`), and a poll with nothing to report is one request returning an empty list.

Deletions are included, because "another device deleted this key" matters as much as "another device changed it". The client also drops its memoised file id for anything the feed reports as removed, so a stale id cannot keep answering reads.

The first tick only establishes the starting cursor - otherwise every subscriber would be told, on launch, that everything that ever happened had just changed.

## Storage usage

```ts
const [drive] = await store.getQuota()
// { provider: 'googleDrive', usedBytes: 4_100_000_000, totalBytes: 15_000_000_000 }
```

This is the whole Google account's usage, not the `appDataFolder`'s share - Drive reports no per-folder figure. It is the number that matters anyway, since the account limit is what a write actually hits.

`totalBytes` is absent for a pooled or unlimited Workspace account. That is not zero, and a "you are out of space" prompt that treats it as zero is worse than no prompt.

## Cancelling a transfer

```ts
const controller = new AbortController()

await googleDriveFiles.save({
  name: 'backup.sqlite',
  fileUri: localPath,
  signal: controller.signal,
})
```

Checked between chunks, so a cancel lands during the transfer rather than after it. Bytes Drive already accepted stay in the resumable session; a later `save` of the same name starts a fresh one.

`signal` is typed structurally, so a polyfilled `AbortController` works and you do not need `lib.dom` in your tsconfig.
