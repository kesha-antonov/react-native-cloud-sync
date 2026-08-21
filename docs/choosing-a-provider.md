# Choosing a provider

Five providers, each usable directly - four of them through the [store facade](store.md). This page is the decision, not the reference.

## Quick answer

| If you… | Use |
|---|---|
| Sync a handful of small settings across a user's Apple devices | `icloudKV` |
| Sync structured app data, and want it on Android or web too | `cloudKit` |
| Want one always-on backend that behaves the same everywhere | `googleDrive` |
| Want iCloud on Apple and something sensible on Android, automatically | the [facade](store.md) with `['icloudKV', 'googleDrive']` |
| Want the *same* data on Apple and non-Apple devices, both writing | the facade with `writeMode: 'mirror'` and a `resolve` function |
| Give the user a file they can open in Files.app | `icloudDocuments` (Apple) / `googleDriveFiles` (elsewhere) |
| Store something genuinely sensitive, Apple-only | `cloudKitEncrypted` - see [Encryption](encryption.md) |

## Platform support

|  | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| `icloudKV` | native | – | – |
| `cloudKit` | native | REST | REST |
| `cloudKitEncrypted` | native | – | – |
| `icloudDocuments` | native | – | – |
| `googleDrive` | REST | REST | REST |

An unavailable provider rejects with `ERR_UNSUPPORTED_PLATFORM` rather than doing nothing silently - call `isAvailable()` to branch without a `try`/`catch`.

## What each one costs you

### `icloudKV`

Free for the user - no sign-in, no consent screen, no account picker, and the only provider usable from a cold start with no UI. Trade-off: 1 MB total, 1 MB per key, 1024 keys, unreachable from Android or a browser - see [iCloud key-value store](providers/icloud-kv.md#limits-are-enforced-not-discovered).

### `cloudKit`

The only provider reaching identical data from iOS, Android and web - the same private database everywhere. Frictionless on Apple (implicit auth, no UI); on Android/web it needs an interactive Apple ID sign-in whose token expires in 30 minutes to 2 weeks with no refresh - see [the constraint](providers/cloudkit.md#the-constraint-on-android-and-web). Treat it there as a deliberate import/export ("bring my iPhone data over"), not a background backup.

### `cloudKitEncrypted`

Values go into `CKRecord.encryptedValues`, encrypted on device with a key from the user's iCloud Keychain - Apple stores ciphertext it can't read. Apple-only, permanently, since the key never reaches Apple's servers. Values aren't queryable and keys aren't encrypted - see [Encryption](encryption.md#cloudkits-native-encryption) for the full picture, including a `codec` for the same guarantee cross-platform.

### `icloudDocuments`

The only provider the user can actually see: files land in their iCloud Drive, browsable in Files.app. They can delete, rename, or move a file at any time without telling your app, so treat a missing file as normal, not corruption. Apple-only, permanently, and not part of the store facade - see [iCloud Drive](providers/icloud-drive.md).

### `googleDrive`

Same behavior everywhere, including web, with no periodic re-auth - the sensible always-on backend for a cross-platform app. Needs an explicit Google sign-in and the `drive.appdata` scope; you supply the token. Data lives in the hidden `appDataFolder`, invisible in the user's Drive - see [Google Drive](providers/google-drive.md).

## Recommended combinations

#### Apple-first app, small settings

`icloudKV` alone. Zero friction.

#### Apple-first app, real data

`cloudKit` alone on iOS. Add `googleDrive` if you ship Android.

#### Cross-platform app, each device on its own cloud

The facade with `['icloudKV', 'googleDrive']`. Apple users get zero-friction iCloud; everyone else gets Drive.

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  tiering: 'auto',
})
```

Writes go to the first available provider only, so an Android device has nothing to find - see [failover](store.md#failover---the-providers-are-alternatives). Right shape when the two are alternatives, not cross-device sync.

#### Cross-platform app, same data on every device

Add `writeMode: 'mirror'` so every write goes to both, and a `resolve` function so reads pick the newest copy rather than the first one found:

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
  resolve: resolveByTimestamp('updatedAt'),
  tiering: 'auto',
})
```

Both parts are needed: `mirror` puts a copy in Drive so a non-Apple device has something to read at all; `resolve` stops an Apple device returning its own stale iCloud copy instead of consulting Drive. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).

### It works in either direction

Nothing here assumes Apple is the primary platform - the same configuration covers the mirror image:

| Starting point | What happens |
|---|---|
| iPhone first, later an Android phone or a browser | Writes go to iCloud and Drive; the Android device reads Drive |
| Android or web first, later a Mac, iPad or iPhone | Writes go to Drive; the new Apple device reads Drive, and mirroring starts populating iCloud too |

An Android user's data lives only in Drive. Adding an iPad configures both providers: the resolver picks Drive since iCloud is empty, and read repair copies it into iCloud - see [two-way sync](store.md#two-way-sync-across-a-mixed-fleet) for the mechanism.

The only asymmetry is Apple's own: an Android or web device can't reach `icloudKV` at all, so Drive has to be in the list for any cross-platform story to work.

#### Cross-platform, but the data must be the same account everywhere

`cloudKit` everywhere, with the Android/web halves framed as an explicit import.

## Better still: let the user choose

Everything above assumes *you* pick. Where you reasonably can, expose the choice instead - a settings row listing the providers that work on this device, plus an off switch. Costs little, buys a lot:

- not everyone has both accounts - an Android user may have no Apple ID, an iPhone user may not want a Google account
- it's a privacy decision, and it's theirs to make - "which company holds my data, if anyone" isn't a developer's to answer silently; the data is theirs, the cloud is just where a copy lives
- it makes failure states legible - a user who chose Drive understands a "reconnect Google" prompt; one who never knew Drive was involved doesn't

Because every provider implements the same interface, switching at runtime is just rebuilding the store:

```ts
const store = createCloudStore({
  providers: chosen === 'off' ? [] : [chosen],
  tiering: 'auto',
  outboxStorage: mmkvAdapter,
})
```

An empty list isn't a silent no-op: a store with no providers rejects every write with `ERR_NOT_SIGNED_IN` - the wrong thing to show someone who deliberately turned sync off, and it won't queue either since that error counts as needing user action. Branch before you call, rather than letting the store reject:

```ts
export async function save (key: string, value: string) {
  mmkv.set(key, value)                    // local first, always
  if (chosen === 'off') return            // sync is off: nothing more to do
  await store.setItem(key, value)
}
```

That keeps the app writing locally when the cloud is off, which is what the user asked for - not "stop saving my data".

### "Also back up to Google Drive"

Mirroring is worth surfacing as its own opt-in: an iPhone user is already synced across their Apple devices for free, with no sign-in, so connecting Drive buys exactly one thing - reachability from a non-Apple device. Ask for it in those terms, at a moment when it means something, not as a checkbox labelled "enable mirroring".

```
☑  Also back up to Google Drive
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

A few things worth being upfront about:

- needs a Google sign-in - let the user cancel without the toggle flipping
- existing data doesn't move by itself - turning it on mirrors future writes only, so run `migrate({ from: 'icloudKV', to: 'googleDrive' })` once on enable
- turning it off should also ask about the copy - "stop backing up" and "delete what's already there" are different intentions, covered below
- two clouds, two ways to fail - `mirror` succeeds if either destination takes the write, but an expired Google token still needs surfacing

On Android and web the framing inverts: there's no iCloud fallback, so Drive isn't an extra - it's the only option, the backup feature itself. Ask for "Back up your data", not "also back up".

If that user later picks up an iPad, nothing needs re-explaining - it connects the same Google account, reads the data out of Drive, and starts mirroring into iCloud too.

A few more things easy to get wrong. Filter with `isAvailable()` rather than listing every provider and letting the user pick one that will immediately fail:

```ts
const options = (
  await Promise.all(
    ([icloudKV, cloudKit, googleDrive] as const).map(
      async p => [p.name, await p.isAvailable()] as const
    )
  )
).filter(([, ok]) => ok).map(([name]) => name)
```

Include an off switch, and mean it - some people don't want a cloud copy at all, so "off" should stop writing and offer to remove what's already stored.

When a user turns sync off and asks you to remove the backup, delete every key you ever wrote, not just the two obvious ones - enumerate rather than hardcode:

```ts
for (const key of await provider.getAllKeys())
  await provider.removeItem(key)
```

Leaving stray keys behind after someone explicitly asked you to delete their data is worse than never having offered the switch.

Working code for the whole flow - picker, switching, migration, off, delete - is in [Recipes](recipes.md#let-the-user-choose-their-provider).

## What none of them do

Not a general file-sync API. `googleDrive` and `cloudKit` assets handle binaries, but this package is built around durable key-value and record storage - for arbitrary user-visible files, you want a different library.
