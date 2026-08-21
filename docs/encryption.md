# Encryption

Whether your data is end-to-end encrypted depends on the backend. Short version first, then how to add it yourself where it's missing.

## What you get without doing anything

| Backend | Encrypted in transit | Encrypted at rest | End-to-end |
|---|:---:|:---:|:---:|
| CloudKit private database, plain fields | ✅ | ✅ (Apple's keys) | – |
| CloudKit via `cloudKitEncrypted` | ✅ | ✅ | ✅ **natively** |
| iCloud key-value store | ✅ | ✅ (Apple's keys) | only under [ADP](#advanced-data-protection) |
| iCloud Drive (`icloudDocuments`) | ✅ | ✅ (Apple's keys) | only under [ADP](#advanced-data-protection) |
| Google Drive `appDataFolder` | ✅ | ✅ (Google's keys) | – |

"End-to-end" means the provider stores ciphertext it cannot decrypt. Everything else is encrypted in transit and at rest, but the provider holds a key - readable by them, by a legal request, or by anyone who compromises the account.

Two things worth internalising:

- CloudKit has real, native end-to-end encryption, and this package exposes it - no key management, no passphrase, nothing to lose
- Google Drive has none: `appDataFolder` is hidden from the user's Drive UI, not private - anything holding the OAuth token can read it, including your own backend. Want E2E on Drive? You build it

## CloudKit's native encryption

Apple encrypts `CKRecord` fields written through `encryptedValues` on device, with a key from the user's iCloud Keychain - Apple's servers store ciphertext and never see the key.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
const token = await cloudKitEncrypted.getItem('auth.refreshToken')
```

Or through the facade:

```ts
const secrets = createCloudStore({ providers: ['cloudKitEncrypted'] })
```

Best option when it fits: the hardest part of end-to-end encryption - getting the key onto other devices without ever putting it on a server - is already solved by the iCloud Keychain.

### What it costs

Apple platforms only, permanently - the key is in the iCloud Keychain, which CloudKit Web Services cannot reach. A value written here isn't "hard to read" from Android and web, it's *unreadable*. `cloudKitEncrypted.isAvailable()` returns false there, and every operation rejects with `ERR_UNSUPPORTED_PLATFORM`.

Don't mix it into a store with a plaintext provider:

```ts
// Wrong. The Drive copy is plaintext, so the encryption bought you nothing.
createCloudStore({ providers: ['cloudKitEncrypted', 'googleDrive'], writeMode: 'mirror' })
```

If the same data has to be readable off Apple platforms, use the [codec](#doing-it-yourself) instead - a key you manage works everywhere, at the cost of you managing it.

Values aren't queryable either - CloudKit can't index an encrypted field, so there's no server-side filtering or sorting (`getAllKeys()` still works, since it queries record *names*). Keys aren't encrypted - record names are visible to Apple, only values are protected, so `settings.theme` is fine as a key but `patient.7f3a-diagnosis-hiv` is not. Put nothing sensitive in a key; the codec approach needs the same discipline, since `getAllKeys()`, tiering and read repair all need cleartext keys.

It's also a separate record type (`EncryptedKVBlob`, not `cloudKit`'s `KVBlob`): CloudKit records encryption in the schema, so a field cannot be encrypted for one write and plain for another - the two providers would collide on a field-type conflict if they shared one. `cloudKit` and `cloudKitEncrypted` are separate stores; moving data between them is a `migrate()`.

### Advanced Data Protection

Separate from the above, and outside your app's control. [ADP][adp] is a user-facing iCloud setting extending end-to-end encryption to most iCloud categories, including iCloud Drive and iCloud backups - on, `icloudDocuments` files and device backups become E2E encrypted; off (the default), Apple holds those keys.

There is no public API to detect or request it, so treat it as a bonus rather than a guarantee. `cloudKitEncrypted` is E2E either way, which is the point of using it.

## Google Drive has none

`appDataFolder` gives you obscurity, not confidentiality:

- hidden from the user's Drive UI, so they will not stumble on it or delete it by accident;
- scoped to your app's OAuth client, so another app cannot request it;
- but stored under Google's keys, readable by Google, and readable by anything holding a valid access token.

Google Workspace has a client-side encryption feature, but it's admin-configured, enterprise-only, and unreachable from the `drive.appdata` scope - not an option for a mobile app.

So on Drive, end-to-end encryption is something you add.

## Doing it yourself

`createCloudStore` takes a `codec` - a two-way value transform applied at the boundary between the store and its providers.

```ts
const store = createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: (value, key) => encrypt(value, key),
    decode: (value, key) => decrypt(value, key),
  },
})
```

The provider only ever sees ciphertext; your app only ever sees plaintext, and both halves may be async. This package deliberately ships **no cipher** - bring a library you chose: `react-native-quick-crypto`, `expo-crypto` plus a Keychain-backed key, `libsodium`.

### What it applies to, and what it does not

| | |
|---|---|
| Values | Encrypted |
| Keys | **Not** encrypted - `getAllKeys()`, tiering and read repair all need them |
| The outbox | Holds ciphertext, so a persisted queue never contains plaintext |
| `migrate()` | Moves ciphertext verbatim; migration does not need the key |
| Resolvers | Run on **plaintext** - decoding happens before your `resolve` function |
| Tiering | Routes on the **encrypted** size, because that is what actually gets stored |
| `cloudKitAssets` / `googleDriveFiles` / `icloudDocuments` | Not covered - they move files by path, not values through the store. Encrypt the file yourself before handing it over |

The last three rows are what catch people: a codec that inflates a value by 40% can push it over a tiering threshold, so your effective `kvMaxBytes` is smaller than it looks - see [Encrypting at rest](store.md#encrypting-at-rest) for the full mechanism.

### Where the key lives

The whole problem: encryption is easy, getting the same key onto a second device without the provider reading it is not.

#### A passphrase the user remembers

Works on every platform, and the provider never has anything usable.

```ts
import { pbkdf2 } from 'your-crypto-lib'

const key = await pbkdf2(passphrase, salt, { iterations: 600_000, length: 32 })
```

The cost is real: forget the passphrase, lose the data - no reset, by construction. Say so plainly in the UI at the moment they set it, not in a settings screen they will never open.

#### The iCloud Keychain, for Apple-only apps

A Keychain item marked synchronizable propagates to the user's other Apple devices, end-to-end encrypted, with no passphrase - exactly what `cloudKitEncrypted` does internally, so use that instead of rebuilding it.

#### A random data key, wrapped by a passphrase-derived key

The one to reach for if you expect to support a passphrase change, or more than one unlock method later.

```ts
// Once, at setup:
const dataKey = randomBytes(32)                       // never leaves the device unwrapped
const wrapped = await wrap(dataKey, await derive(passphrase))
await store.setItem('crypto.wrappedKey', toBase64(wrapped))   // safe to sync
```

Changing the passphrase then re-wraps 32 bytes instead of re-encrypting every value. Treat the wrapped key as the one value you never encrypt with the codec - write it through a second store, or a provider directly, so you are not trying to decrypt the key with itself.

### Tell a wrong key from corrupt data

Store a canary alongside the wrapped key - a known plaintext, encrypted; if it doesn't decrypt, the passphrase is wrong. Without one, a wrong passphrase and genuinely damaged data look identical, and you show the wrong error.

```ts
const canary = await store.getItem('crypto.canary')
if (canary !== 'rncs-ok') return promptPassphraseAgain()
```

Use an authenticated cipher (AES-GCM, XChaCha20-Poly1305) so a wrong key *fails* rather than producing garbage. The store surfaces a throwing `decode` as an error, not a value - pinned by the test suite - so an authentication-tag mismatch reaches your `catch` instead of becoming corrupt state.

### A worked example

```ts
import { createCloudStore } from 'react-native-cloud-sync'
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from 'your-crypto-lib'

function encryptedStore (dataKey: Uint8Array) {
  return createCloudStore({
    providers: ['googleDrive'],
    outboxStorage: mmkvAdapter,
    codec: {
      encode: async (value) => {
        // A fresh nonce per write. Reusing one across writes is the classic
        // way to destroy GCM's guarantees.
        const nonce = randomBytes(12)
        const ciphertext = await aesGcmEncrypt(value, dataKey, nonce)
        return `${toBase64(nonce)}.${toBase64(ciphertext)}`
      },
      decode: async (stored) => {
        const [nonce, ciphertext] = stored.split('.')
        // Throws on an authentication-tag mismatch, which is what we want -
        // a wrong key must not read as a successful decode.
        return await aesGcmDecrypt(fromBase64(ciphertext), dataKey, fromBase64(nonce))
      },
    },
  })
}
```

One consequence of the fresh nonce: identical plaintext produces different ciphertext each time, so [read repair](store.md#two-way-sync-across-a-mixed-fleet) rewrites bytes even when nothing changed. Harmless, but it costs a request - turn off `repairOnRead` if that matters and you are not running a mixed fleet.

## Choosing

| | |
|---|---|
| Apple-only, sensitive data | `cloudKitEncrypted`. Nothing to manage, nothing to lose. |
| Cross-platform, sensitive data | `codec` with a passphrase-derived key |
| Cross-platform, mildly sensitive | Drive's `appDataFolder` on its own may be enough - decide deliberately rather than by default |
| Files rather than values | Encrypt before handing the path to `icloudDocuments` / `googleDriveFiles` |

And the question worth asking before any of it: does this data need to leave the device at all? The cheapest way to protect a secret in a sync library is not to sync it.

[adp]: https://support.apple.com/en-us/102651
