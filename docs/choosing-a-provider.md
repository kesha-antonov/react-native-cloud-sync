# Choosing a provider

Five providers, each usable directly; four also work through the [store facade](store.md). This page helps you pick; the provider pages are the reference.

## Quick answer

| If you... | Use |
|---|---|
| Sync a few small settings across a user's Apple devices | `icloudKV` |
| Sync structured app data, optionally on Android or web too | `cloudKit` |
| Want one always-on backend that behaves the same everywhere | `googleDrive` |
| Want iCloud on Apple and a fallback on Android, automatically | the [facade](store.md) with `['icloudKV', 'googleDrive']` |
| Want the same data on Apple and non-Apple devices, both writing | the facade with `writeMode: 'mirror'` and a `resolve` function |
| Give the user a file they can open in Files.app | `icloudDocuments` (Apple) / `googleDriveFiles` (elsewhere) |
| Store something sensitive, Apple-only | `cloudKitEncrypted` - see [Encryption](encryption.md) |

## Platform support

|  | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| `icloudKV` | native | - | - |
| `cloudKit` | native | REST | REST |
| `cloudKitEncrypted` | native | - | - |
| `icloudDocuments` | native | - | - |
| `googleDrive` | REST | REST | REST |

An unsupported provider rejects with `ERR_UNSUPPORTED_PLATFORM`. Call `isAvailable()` to branch without `try`/`catch`.

## What each one costs you

### `icloudKV`

No sign-in, consent screen or account picker; the only provider usable from a cold start with no UI. Limits: 1 MB total, 1 MB per key, 1024 keys, and no access from Android or a browser. See [iCloud key-value store](providers/icloud-kv.md#limits-are-enforced-not-discovered).

### `cloudKit`

The only provider that reaches the same private database from iOS, Android and web. No UI on Apple. On Android/web it needs an interactive Apple ID sign-in whose token expires after 30 minutes to 2 weeks, with no refresh (see [the constraint](providers/cloudkit.md#the-constraint-on-android-and-web)). Use it there for a deliberate import ("bring my iPhone data over"), not background backup.

### `cloudKitEncrypted`

Values go into `CKRecord.encryptedValues`, encrypted on device with a key from the user's iCloud Keychain; Apple stores ciphertext it cannot read. Apple-only, permanently. Values are not queryable and keys are not encrypted. See [Encryption](encryption.md#cloudkits-native-encryption), including a `codec` for the same guarantee cross-platform.

### `icloudDocuments`

The only provider the user can see: files land in their iCloud Drive, in Files.app. They can delete, rename or move files at any time, so treat a missing file as normal. Apple-only, and not part of the store facade. See [iCloud Drive](providers/icloud-drive.md).

### `googleDrive`

Same behavior everywhere, including web, with no periodic re-auth: the default always-on backend for a cross-platform app. Needs a Google sign-in with the `drive.appdata` scope; you supply the token. Data lives in the hidden `appDataFolder`. See [Google Drive](providers/google-drive.md).

## Recommended combinations

#### Apple-first app, small settings

`icloudKV` alone.

#### Apple-first app, real data

`cloudKit` on iOS. Add `googleDrive` if you ship Android.

#### Cross-platform app, each device on its own cloud

The facade with `['icloudKV', 'googleDrive']`. Apple users get iCloud with no sign-in; everyone else gets Drive.

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  tiering: 'auto',
})
```

Writes go to the first available provider only, so an Android device will not see iPhone data (see [failover](store.md#failover---the-providers-are-alternatives)). Use this when the providers are alternatives, not for cross-device sync.

#### Cross-platform app, same data on every device

Add `writeMode: 'mirror'` so every write goes to both, and a `resolve` function so reads pick the newest copy:

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
  resolve: resolveByTimestamp('updatedAt'),
  tiering: 'auto',
})
```

You need both: `mirror` puts a copy in Drive for non-Apple devices; `resolve` stops an Apple device returning its own stale iCloud copy. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).

### It works in either direction

The same configuration works whichever platform the user starts on:

| Starting point | What happens |
|---|---|
| iPhone first, later an Android phone or a browser | Writes go to iCloud and Drive; the Android device reads Drive |
| Android or web first, later a Mac, iPad or iPhone | Writes go to Drive; the Apple device reads Drive, and mirroring starts filling iCloud |

In the second case, iCloud starts empty, so the resolver picks Drive and read repair copies the data into iCloud. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).

Android and web cannot reach `icloudKV`, so Drive must be in the list for any cross-platform setup.

#### Cross-platform, but the data must be the same account everywhere

`cloudKit` everywhere, with Android/web framed as an explicit import.

## Better still: let the user choose

Where you can, let the user pick: a settings row listing the providers that work on this device, plus an off switch. Reasons:

- not everyone has both accounts; an Android user may have no Apple ID, an iPhone user may not want Google
- which company holds their data, if any, is the user's decision
- failures make sense: a user who chose Drive understands a "reconnect Google" prompt

Every provider implements the same interface, so switching means rebuilding the store:

```ts
const store = createCloudStore({
  providers: chosen === 'off' ? [] : [chosen],
  tiering: 'auto',
  outboxStorage: mmkvAdapter,
})
```

A store with no providers rejects every write with `ERR_NOT_SIGNED_IN` and does not queue it (that error needs user action). That is the wrong message for someone who turned sync off, so branch before calling:

```ts
export async function save (key: string, value: string) {
  mmkv.set(key, value)                    // local first, always
  if (chosen === 'off') return            // sync is off: nothing more to do
  await store.setItem(key, value)
}
```

The app keeps saving locally when the cloud is off.

### "Also back up to Google Drive"

Offer mirroring as its own opt-in. An iPhone user already syncs across Apple devices with no sign-in, so Drive adds one thing: access from a non-Apple device. Ask in those terms, when it matters, not as "enable mirroring".

```
[x] Also back up to Google Drive
    Your data already syncs across your Apple devices via iCloud.
    Connecting Google Drive as well lets you restore it on an Android
    device or in a browser.
```

```ts
const store = createCloudStore({
  providers: alsoUseDrive ? ['icloudKV', 'googleDrive'] : ['icloudKV'],
  writeMode: alsoUseDrive ? 'mirror' : 'failover',
  tiering: 'auto',
  outboxStorage: mmkvAdapter,
})
```

Things to handle:

- it needs a Google sign-in; if the user cancels, do not flip the toggle
- enabling mirrors future writes only; run `migrate({ from: 'icloudKV', to: 'googleDrive' })` once on enable
- turning it off should ask about the existing copy; "stop backing up" and "delete what is there" are different requests
- with two clouds, `mirror` succeeds if either takes the write, but an expired Google token still needs surfacing

On Android and web, Drive is the only option, not an extra. Ask "Back up your data", not "also back up". If that user later gets an iPad, it connects the same Google account, reads from Drive, and starts mirroring into iCloud.

Offer only providers that work here; filter with `isAvailable()`:

```ts
const options = (
  await Promise.all(
    ([icloudKV, cloudKit, googleDrive] as const).map(
      async p => [p.name, await p.isAvailable()] as const
    )
  )
).filter(([, ok]) => ok).map(([name]) => name)
```

Include an off switch that stops writing and offers to remove what is stored. When the user asks to delete, remove every key you wrote, enumerated rather than hardcoded:

```ts
for (const key of await provider.getAllKeys())
  await provider.removeItem(key)
```

Working code for the whole flow (picker, switching, migration, off, delete) is in [Recipes](recipes.md#let-the-user-choose-their-provider).

## What none of them do

This is not a general file-sync API. `googleDrive` and `cloudKit` assets handle binaries, but the package is built for key-value and record storage. For arbitrary user-visible files, use a different library.
