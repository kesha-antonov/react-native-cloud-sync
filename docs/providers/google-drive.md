# Google Drive

Drive's hidden [`appDataFolder`][appdata] - a per-app, per-Google-account folder that never appears in the user's visible Drive.

## When to use it

The always-on backend for a cross-platform app. It behaves identically on iOS, Android and web, and unlike CloudKit's Android path it needs no periodic re-auth.

| | |
|---|---|
| Platforms | iOS, Android, web |
| Auth | OAuth, [`drive.appdata` scope][drivescopes], supplied by your app |
| Size limits | the user's Drive quota |
| Survives app uninstall | yes - tied to the account, not the install |
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
import { configureGoogleDriveFiles } from 'react-native-cloud-sync'
import * as FileSystem from 'expo-file-system'

configureGoogleDriveFiles({
  statSize: async uri => (await FileSystem.getInfoAsync(uri)).size ?? 0,
  readChunk: (uri, position, length) =>
    FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, position, length }),
  writeChunk: (uri, base64) =>
    FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 }),
  // expo-file-system has no append mode; write-then-read-back-and-concatenate
  // works but is O(n²) over a large file - react-native-fs's appendFile below
  // is the better choice once files get into the hundreds of MB.
  appendChunk: async (uri, base64) => {
    const existing = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
    await FileSystem.writeAsStringAsync(uri, existing + base64, { encoding: FileSystem.EncodingType.Base64 })
  },
})
```

Or with `react-native-fs`, which has a real append and reads the same way:

```ts
import RNFS from 'react-native-fs'

configureGoogleDriveFiles({
  statSize: async uri => (await RNFS.stat(uri)).size,
  readChunk: (uri, position, length) => RNFS.read(uri, length, position, 'base64'),
  writeChunk: (uri, base64) => RNFS.writeFile(uri, base64, 'base64'),
  appendChunk: (uri, base64) => RNFS.appendFile(uri, base64, 'base64'),
})
```

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

Resumability here is scoped to one call: the upload session lives only in memory, so a chunk that fails mid-flight is retried against Drive's real offset, but a process that dies mid-upload has to restart `save` from byte 0 on the next call. Persisting the session across restarts is not implemented.

For the CloudKit-native equivalent on iOS/macOS, see [assets](cloudkit.md#assets) and [the backup/restore helper](cloudkit.md#backuprestore-helper); [Recipes](../recipes.md#cross-platform-large-file-backup) shows the two paired behind one function.

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
| `ERR_AUTH_EXPIRED` | Drive rejected the token (HTTP 401/403); `onAuthExpired` fires |
| `ERR_RATE_LIMITED` | HTTP 429; `retryAfterMs` set from the `Retry-After` header |
| `ERR_QUOTA_EXCEEDED` | HTTP 507 - the user's Drive is full |

See [Error handling](../errors.md).

## No change events

Drive has no push channel here, so `onRemoteChange` is not implemented. If you need another device's write to arrive without user action, either pair Drive with `icloudKV`/`cloudKit` through the [facade](../store.md), or re-read on app foreground.

[appdata]: https://developers.google.com/workspace/drive/api/guides/appdata
[drivescopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[drivefiles]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
