# Choosing a provider

Three providers, each usable directly or through the [store facade](store.md). This page is the decision, not the reference.

## Quick answer

| If you… | Use |
|---|---|
| Sync a handful of small settings across a user's Apple devices | `icloudKV` |
| Sync structured app data, and want it on Android or web too | `cloudKit` |
| Want one always-on backend that behaves the same everywhere | `googleDrive` |
| Want iCloud on Apple and something sensible on Android, automatically | the [facade](store.md) with `['icloudKV', 'googleDrive']` |

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

**Cross-platform app.** The facade with `['icloudKV', 'googleDrive']`. Apple users get zero-friction iCloud; everyone else gets Drive; reads fall through so a value written by either is found.

```ts
const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  tiering: 'auto',
})
```

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

Three things worth getting right, each of which is easy to get wrong:

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
for (const key of await provider.getAllKeys()) {
  await provider.removeItem(key)
}
```

Leaving stray keys behind after someone explicitly asked you to delete their data is worse than never having offered the switch.

Working code for the whole flow - picker, switching, migration, off, delete - is in [Recipes](recipes.md#let-the-user-choose-their-provider).

## What none of them do

Not a general file-sync API. `googleDrive` and `cloudKit` assets handle binaries, but this package is built around durable key-value and record storage - if you need arbitrary user-visible files in iCloud Drive, you want a different library.
