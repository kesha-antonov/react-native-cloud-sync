# Choosing a provider

Three providers, each usable directly or through the [store facade](store.md). This page is the decision, not the reference.

## Quick answer

| If you… | Use |
|---|---|
| Sync a handful of small settings across a user's Apple devices | `icloudKV` |
| Sync structured app data, and want it on Android or web too | `cloudKit` |
| Want one always-on backend that behaves the same everywhere | `googleDrive` |
| Want iCloud on Apple and something sensible on Android, automatically | the [facade](store.md) with `['icloudKV', 'googleDrive']` |
| Want the *same* data on Apple and non-Apple devices, both writing | the facade with `writeMode: 'mirror'` **and** a `resolve` function |

## Platform support

|  | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| `icloudKV` | native | – | – |
| `cloudKit` | native | REST | REST |
| `googleDrive` | REST | REST | REST |

Where a provider is unavailable it rejects with `ERR_UNSUPPORTED_PLATFORM` rather than silently doing nothing. Call `isAvailable()` to branch without a `try`/`catch`.

## What each one costs you

### `icloudKV`

**Free for the user.** No sign-in, no consent screen, no account picker - it uses whatever iCloud account is already on the device. That makes it the only provider you can use from a cold start without a UI.

**But it is small and Apple-only.** 1 MB total, 1 MB per key, 1024 keys. And there is no way to reach it from Android or a browser - not a limitation of this package, but of the API: `NSUbiquitousKeyValueStore` has no network surface at all.

### `cloudKit`

**The same private database on every platform.** This is the only provider that reaches identical data from iOS, Android and web.

**On Apple platforms it is as frictionless as `icloudKV`** - implicit auth, no UI.

**On Android and web it is not.** Reaching a user's private database requires an interactive Apple ID sign-in in a WebView, and the resulting token expires after **30 minutes**, or **2 weeks** if the user ticks "Keep me signed in". Apple documents no refresh. There is no way around this: a server-to-server key reaches only the *public* database, and Sign in with Apple identifiers are not linked to CloudKit.

So: on Android and web treat CloudKit as a deliberate **import/export** ("bring my iPhone data to this device"), not as a background backup.

### `googleDrive`

**The same behaviour everywhere**, including web, and no periodic re-auth. That makes it the sensible always-on backend for a cross-platform app.

**It needs an explicit connect step.** The user picks a Google account and grants the `drive.appdata` scope once. You supply the token; this package never owns the consent flow.

Data lives in Drive's hidden `appDataFolder`, so nothing appears in the user's visible Drive, and it survives an app uninstall because it belongs to the account rather than the install.

## Recommended combinations

**Apple-first app, small settings.** `icloudKV` alone. Zero friction.

**Apple-first app, real data.** `cloudKit` alone on iOS. Add `googleDrive` if you ship Android.

**Cross-platform app, each device on its own cloud.** The facade with `['icloudKV', 'googleDrive']`. Apple users get zero-friction iCloud; everyone else gets Drive.

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  tiering: 'auto',
})
```

Read this carefully, because the list does not mean what it looks like: **writes go to the first available provider only.** On an iPhone that is iCloud, and Drive never receives anything. Reads fall through, so each device finds its own copy - but an Android device has nothing to find, because iCloud is unreachable there and nothing wrote to Drive.

That is the right shape when the two are alternatives. It is not cross-device sync.

**Cross-platform app, same data on every device.** Add `writeMode: 'mirror'` so every write goes to both, and a `resolve` function so reads pick the newest copy rather than the first one found:

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
| **Android or web first, later a Mac, iPad or iPhone** | Writes go to Drive; the new Apple device reads Drive, and mirroring starts populating iCloud too |

The Apple side of that second row is worth spelling out. An Android user's data lives only in Drive. When they add an iPad, that iPad is configured with both providers - iCloud is empty, Drive has everything, and the resolver picks Drive. Read repair then copies the value into iCloud, so subsequent reads on Apple devices are served locally and their other Apple devices sync for free.

The only asymmetry is Apple-side, and it is Apple's: an Android or web device cannot reach `icloudKV` at all, so Drive has to be in the list for any cross-platform story to work. Which is why Drive is the sensible always-on backend regardless of which platform came first.

**Cross-platform, but the data must be the same account everywhere.** `cloudKit` everywhere, with the Android/web halves framed as an explicit import.

## Better still: let the user choose

Everything above assumes *you* pick. Where you reasonably can, expose the choice instead - a settings row listing the providers that work on this device, plus an off switch.

It costs little and buys a lot:

- **Not everyone has both accounts.** An Android user may have no Apple ID; an iPhone user may not want a Google account.
- **It is a privacy decision, and it is theirs.** "Which company holds my data, if anyone" is not a question a developer should silently answer for someone.
- **It makes the failure states legible.** A user who chose Drive understands a "reconnect Google" prompt. A user who never knew Drive was involved does not.
- **It is the honest framing.** The data is theirs; the cloud is where a copy lives.

Because every provider implements the same interface, switching at runtime is just rebuilding the store:

```ts
const store = createCloudStore({
  providers: chosen === 'off' ? [] : [chosen],
  tiering: 'auto',
  outboxStorage: mmkvAdapter,
})
```

### "Also back up to Google Drive"

Mirroring is worth surfacing as its own opt-in, because it buys the user something specific and costs them something specific.

An iPhone user is already synced across their Apple devices for free, with no sign-in. Connecting Drive as well buys exactly one thing: **their data becomes reachable from a non-Apple device.** So ask for it in those terms, at a moment when it means something - not as a checkbox labelled "enable mirroring".

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

Some honesty to build into that flow:

- **It needs a Google sign-in.** Do not present it as a free toggle; ticking it opens an account picker and a consent screen. Let the user cancel without the setting flipping.
- **Existing data does not move by itself.** Turning it on starts mirroring *future* writes. Run `migrate({ from: 'icloudKV', to: 'googleDrive' })` once on enable, or the Android device only sees what changed after the tick.
- **Turning it off should ask about the copy.** "Stop backing up to Drive" and "delete what is already there" are different intentions - see below.
- **Two clouds means two ways to fail.** With `mirror` a write succeeds if either destination takes it and the other is retried in the background, so a Drive outage does not block an iCloud user. But an expired Google token still needs surfacing, or their Android restore quietly stops being current.

On Android and web the framing inverts: there is no iCloud to fall back on, so Drive is not an extra - it is the only option, and connecting it is the backup feature itself rather than an add-on. Ask for it as "Back up your data", not "also back up".

And if that user later picks up an iPad, nothing needs re-explaining. The iPad connects the same Google account, reads the existing data out of Drive, and quietly starts mirroring into iCloud as well - so their Apple devices sync with each other from then on.

Three more things worth getting right, each of which is easy to get wrong:

**Only offer what actually works here.** Filter with `isAvailable()` rather than listing every provider and letting the user pick one that will immediately fail:

```ts
const options = (
  await Promise.all(
    ([icloudKV, cloudKit, googleDrive] as const).map(
      async p => [p.name, await p.isAvailable()] as const
    )
  )
).filter(([, ok]) => ok).map(([name]) => name)
```

**Include an off switch, and mean it.** Some people do not want a cloud copy at all. "Off" should stop writing *and* offer to remove what is already stored.

**Deleting means deleting everything.** When a user turns sync off and asks you to remove the backup, remove every key you ever wrote - not the two obvious ones. Enumerate rather than hardcode:

```ts
for (const key of await provider.getAllKeys())
  await provider.removeItem(key)
```

Leaving stray keys behind after someone explicitly asked you to delete their data is worse than never having offered the switch.

Working code for the whole flow - picker, switching, migration, off, delete - is in [Recipes](recipes.md#let-the-user-choose-their-provider).

## What none of them do

Not a general file-sync API. `googleDrive` and `cloudKit` assets handle binaries, but this package is built around durable key-value and record storage - if you need arbitrary user-visible files in iCloud Drive, you want a different library.
