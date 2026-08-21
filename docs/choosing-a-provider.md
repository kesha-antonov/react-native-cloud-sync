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

Where a provider is unavailable it rejects with `ERR_UNSUPPORTED_PLATFORM` rather than silently doing nothing. Call `isAvailable()` to branch without a `try`/`catch`.

## What each one costs you

### `icloudKV`

It's free for the user - no sign-in, no consent screen, no account picker. It uses whatever iCloud account is already on the device, which makes it the only provider you can use from a cold start without any UI.

The trade-off is size and platform: 1 MB total, 1 MB per key, 1024 keys, and no way to reach it from Android or a browser. That's not a limitation of this package - `NSUbiquitousKeyValueStore` has no network surface at all.

### `cloudKit`

This is the only provider that reaches identical data from iOS, Android and web - the same private database on every platform.

On Apple platforms it's as frictionless as `icloudKV`: implicit auth, no UI. On Android and web it isn't. Reaching a user's private database there requires an interactive Apple ID sign-in in a WebView, and the resulting token expires after 30 minutes, or 2 weeks if the user ticks "Keep me signed in" - Apple documents no refresh, and there's no way around it. A server-to-server key only reaches the public database, and Sign in with Apple identifiers aren't linked to CloudKit.

So on Android and web, treat CloudKit as a deliberate import/export ("bring my iPhone data to this device"), not as a background backup.

### `cloudKitEncrypted`

Values go into `CKRecord.encryptedValues`, encrypted on device with a key from the user's iCloud Keychain. Apple stores ciphertext and can't read it - no key for you to manage, no passphrase for the user to lose, since the hard part of end-to-end encryption (key distribution across a user's devices) is already solved by the iCloud Keychain.

That's also why it's Apple-only. The key never reaches Apple's servers, so CloudKit Web Services can't decrypt it either - a value written here is unreadable from Android and web, permanently. That's what end-to-end means, not a gap to be closed.

Values aren't queryable, and keys aren't encrypted, so put nothing sensitive in a key. Don't mirror this alongside a plaintext provider either - the other copy undoes the encryption. If the same data needs to be readable off Apple, use the store's `codec` with a key you manage instead.

### `icloudDocuments`

This is the only provider the user can actually see. Files land in your app's folder in their iCloud Drive, browsable in Files.app, syncing across their Apple devices and surviving an app uninstall - every other provider here stores data the user has no way to reach.

That visibility cuts both ways: they can delete a file, rename it, or move it somewhere else, at any time, without telling your app. User-visible storage is user-controlled storage, so treat a missing file as normal rather than as corruption.

It's Apple-only, permanently - not a gap waiting to be filled. iCloud Drive is a filesystem feature with no REST surface and no browser API; use `googleDriveFiles` for the same job elsewhere. It also isn't part of the store facade, since it moves files by path rather than keys to string values - the same reason `cloudKitAssets` is its own API.

### `googleDrive`

Same behaviour everywhere, including web, with no periodic re-auth - which makes it the sensible always-on backend for a cross-platform app.

It does need an explicit connect step: the user picks a Google account and grants the `drive.appdata` scope once. You supply the token; this package never owns the consent flow.

Data lives in Drive's hidden `appDataFolder`, so nothing appears in the user's visible Drive, and it survives an app uninstall because it belongs to the account rather than the install.

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

Note that writes go to the first available provider only. On an iPhone that's iCloud, and Drive never receives anything. Reads fall through, so each device finds its own copy - but an Android device has nothing to find, since iCloud is unreachable there and nothing wrote to Drive.

That is the right shape when the two are alternatives. It is not cross-device sync.

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

Both parts are needed, and for different reasons. `mirror` puts a copy in Drive so a non-Apple device has something to read at all. `resolve` stops an Apple device returning its own stale iCloud copy without ever consulting Drive - which is what happens by default, because the first provider holding a value wins. See [two-way sync](store.md#two-way-sync-across-a-mixed-fleet).

### It works in either direction

Nothing here assumes Apple is the primary platform. The same configuration covers the mirror image:

| Starting point | What happens |
|---|---|
| iPhone first, later an Android phone or a browser | Writes go to iCloud and Drive; the Android device reads Drive |
| Android or web first, later a Mac, iPad or iPhone | Writes go to Drive; the new Apple device reads Drive, and mirroring starts populating iCloud too |

An Android user's data lives only in Drive. When they add an iPad, that iPad is configured with both providers - iCloud is empty, Drive has everything, and the resolver picks Drive. Read repair then copies the value into iCloud, so subsequent reads on Apple devices are served locally, and their other Apple devices sync for free.

The only asymmetry is Apple-side, and it is Apple's: an Android or web device cannot reach `icloudKV` at all, so Drive has to be in the list for any cross-platform story to work. Which is why Drive is the sensible always-on backend regardless of which platform came first.

#### Cross-platform, but the data must be the same account everywhere

`cloudKit` everywhere, with the Android/web halves framed as an explicit import.

## Better still: let the user choose

Everything above assumes *you* pick. Where you reasonably can, expose the choice instead - a settings row listing the providers that work on this device, plus an off switch. It costs little and buys a lot:

- not everyone has both accounts - an Android user may have no Apple ID, an iPhone user may not want a Google account
- it's a privacy decision, and it's theirs: "which company holds my data, if anyone" isn't a question a developer should silently answer for someone
- it makes the failure states legible - a user who chose Drive understands a "reconnect Google" prompt; a user who never knew Drive was involved doesn't
- it's the honest framing: the data is theirs, the cloud is just where a copy lives

Because every provider implements the same interface, switching at runtime is just rebuilding the store:

```ts
const store = createCloudStore({
  providers: chosen === 'off' ? [] : [chosen],
  tiering: 'auto',
  outboxStorage: mmkvAdapter,
})
```

An empty list isn't a silent no-op, though: a store with no providers rejects every write with `ERR_NOT_SIGNED_IN`, which is the wrong thing to show someone who deliberately turned sync off - and it doesn't get queued either, since that error counts as needing user action. Branch before you call, rather than letting the store reject:

```ts
export async function save (key: string, value: string) {
  mmkv.set(key, value)                    // local first, always
  if (chosen === 'off') return            // sync is off: nothing more to do
  await store.setItem(key, value)
}
```

That also keeps the app writing locally when the cloud is switched off, which is what the user asked for - not "stop saving my data".

### "Also back up to Google Drive"

Mirroring is worth surfacing as its own opt-in - it buys the user something specific and costs them something specific.

An iPhone user is already synced across their Apple devices for free, with no sign-in. Connecting Drive as well buys exactly one thing: their data becomes reachable from a non-Apple device. Ask for it in those terms, at a moment when it means something, rather than as a checkbox labelled "enable mirroring".

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

- it needs a Google sign-in - don't present it as a free toggle, since ticking it opens an account picker and a consent screen; let the user cancel without the setting flipping
- existing data doesn't move by itself - turning it on starts mirroring future writes only, so run `migrate({ from: 'icloudKV', to: 'googleDrive' })` once on enable, or the Android device only sees what changed after the tick
- turning it off should ask about the copy too - "stop backing up to Drive" and "delete what's already there" are different intentions, covered below
- two clouds means two ways to fail - with `mirror` a write succeeds if either destination takes it and the other retries in the background, so a Drive outage doesn't block an iCloud user, but an expired Google token still needs surfacing or the Android restore quietly goes stale

On Android and web the framing inverts: there is no iCloud to fall back on, so Drive is not an extra - it is the only option, and connecting it is the backup feature itself rather than an add-on. Ask for it as "Back up your data", not "also back up".

And if that user later picks up an iPad, nothing needs re-explaining. The iPad connects the same Google account, reads the existing data out of Drive, and quietly starts mirroring into iCloud as well - so their Apple devices sync with each other from then on.

A few more things that are easy to get wrong:

Filter with `isAvailable()` rather than listing every provider and letting the user pick one that will immediately fail:

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

Not a general file-sync API. `googleDrive` and `cloudKit` assets handle binaries, but this package is built around durable key-value and record storage - if you need arbitrary user-visible files in iCloud Drive, you want a different library.
