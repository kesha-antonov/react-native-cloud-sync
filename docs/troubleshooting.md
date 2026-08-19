# Troubleshooting

## "The native module doesn't seem to be linked"

Run `pod install` and rebuild the app. Restarting Metro is not enough - the native module is compiled into the binary. Expo Go cannot load custom native modules at all; you need a development build.

## Writes appear to work but nothing reaches iCloud

Check `getAccountStatus()` first. A signed-out device accepts key-value writes locally and simply never uploads them - there is no error to catch, because nothing failed.

```ts
const status = await icloudKV.getAccountStatus()
if (status !== 'available') promptSignIn(status)
```

## `ERR_CONTAINER_MISCONFIGURED`

Either the app has no iCloud entitlement, or the container identifier in the entitlements file does not match the container that exists in the CloudKit Console. The identifier is read from entitlements at runtime, so an app-config mismatch shows up here rather than silently using the wrong container.

## Nothing appears on the other device

Development and Production are separate CloudKit datastores. A debug build and a TestFlight or App Store build do not share data, and a schema created in Development must be deployed to Production before a release build can use it.

Also confirm both devices are on the same iCloud account, and that the schema record type exists in the environment you are pointing at.

## Android CloudKit stops working after a while

Expected. The `ckWebAuthToken` expires after 30 minutes, or 2 weeks if the user ticked "Keep me signed in", and Apple documents no refresh. Handle `ERR_AUTH_EXPIRED` by prompting for sign-in again rather than retrying.

If it stops after exactly one request, that is a different problem - check that the token is being persisted rather than re-read from an empty store.

## The Apple ID sign-in WebView does nothing on Android

Two likely causes:

- The **Sign In Callback** in the CloudKit Console does not exactly match the scheme you intercept. Use `cloudkit-<container-id>://callback`.
- You are intercepting with `onShouldStartLoadWithRequest`, which is not dependable for Android's server-side 302 redirects. Intercept at the native page-load level instead.

## Queued writes disappear when the app restarts

The outbox defaults to in-memory. Pass `outboxStorage` backed by MMKV or AsyncStorage - see [the outbox](store.md#making-it-durable).

## `getItem` returns null but the data definitely exists

`null` means the key does not exist *in the providers you configured*. Two things to check:

- Provider order. `getItem` falls through the list, but only through providers that report `isAvailable()`.
- Key mismatch. Drive keys are file names; CloudKit keys are record names. They are not automatically the same string unless you make them so.

## Reads are slow on Google Drive

Each read resolves a file name to an id. This package caches ids after the first lookup, so the second read of a key costs nothing - but a cold start pays one query per key. If you read many keys at launch, prefer one larger blob over many small ones.

## An oversized write fails locally

That is deliberate. `ERR_PAYLOAD_TOO_LARGE` carries `limitBytes` and `actualBytes`, and is raised before the request goes out. Either move that key to a larger-capacity provider, or let the [facade](store.md#tiering) route it by size.

## Everything works on iOS and nothing works on web

`icloudKV` has no browser implementation and rejects with `ERR_UNSUPPORTED_PLATFORM`. Use `isAvailable()` to branch, or route through the facade with `googleDrive` in the provider list.
