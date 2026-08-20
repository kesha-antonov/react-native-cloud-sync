# Testing

Cloud storage is the hardest part of a mobile app to test honestly. iCloud on the simulator is unreliable enough that the most-used library in this space [stopped testing on it entirely](https://github.com/kuatsu/react-native-cloud-storage/issues/41) and recommends real devices only - which means the failure paths that matter most are the ones never exercised.

So this package ships an in-memory provider with fault injection, from a real entry point:

```ts
import { createMemoryProvider } from 'react-native-cloud-sync/testing'
```

## Basics

```ts
const provider = createMemoryProvider({
  initial: { 'user/id': '42' },
  accountStatus: 'available',
  latencyMs: 0,
})

await provider.getItem('user/id')   // '42'
```

Register it with the facade to test app code end to end:

```ts
const store = createCloudStore({ providers: ['memory'] })
store.registerProvider(provider)
```

## Injecting failures

```ts
import { ErrorCode } from 'react-native-cloud-sync'

const provider = createMemoryProvider({
  faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
})

await expect(store.setItem('k', 'v')).rejects.toMatchObject({
  code: ErrorCode.QUOTA_EXCEEDED,
})
```

At runtime:

```ts
provider.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE })
provider.setFault('getItem', null)   // clear
```

### Failures that heal

```ts
// Fail twice, then succeed - the shape retry and outbox logic must converge on.
provider.setFault('setItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 2 })

await store.setItem('k', 'v')        // queued
await store.flushOutbox()            // still failing
await store.flushOutbox()            // still failing
await store.flushOutbox()            // drains
```

### Rate limiting with a server hint

```ts
provider.setFault('setItem', {
  code: ErrorCode.RATE_LIMITED,
  retryAfterMs: 90_000,
})
```

Asserts that your backoff honours the server's hint rather than its own schedule.

## Simulating other devices

```ts
provider.emitRemoteChange({ keys: ['user/id'], reason: 'serverChange' })
```

And the case that leaks data between users:

```ts
provider.emitAccountChange({ status: 'available', identityChanged: true })
// Assert that every user-scoped cache was dropped.
```

## Asserting call counts

```ts
expect(provider.calls.setItem).toBe(1)   // no blind second write
```

Useful for proving a retry did *not* happen - for instance that a quota failure surfaced instead of being queued forever.

## Inspecting state

| Member | Purpose |
|---|---|
| `dump()` | Backing map, bypassing fault injection |
| `seed(data)` | Replace data without going through `setItem` |
| `reset()` | Clear data, faults and listeners |
| `calls` | Per-operation call counts |

## Simulating a signed-out fleet

The case that matters most, and the hardest to reach on a device:

```ts
const provider = createMemoryProvider({ available: false, initial: { backup: 'real data' } })

// Not null - null would read as "no backup exists", and the documented
// first-launch recipe seeds empty state on null.
await expect(store.getItem('backup')).rejects.toMatchObject({
  code: ErrorCode.NOT_SIGNED_IN,
})
```

`setAvailable(false)` flips it mid-test, for a session where the user signs out partway through.

## Faults scoped to one key

Real backends fail per record, not per operation - one oversized or conflicting key while the rest of a batch goes through:

```ts
const provider = createMemoryProvider({
  faults: {
    setItem: { code: ErrorCode.QUOTA_EXCEEDED, only: key => key === 'huge' },
  },
})
```

It also makes interleaving tests deterministic, since two operations in flight no longer compete for the same `times` budget.

## Several providers at once

```ts
const apple = createMemoryProvider({ name: 'icloudKV' })
const drive = createMemoryProvider({ name: 'googleDrive' })

const store = createCloudStore({ providers: ['icloudKV', 'googleDrive'], writeMode: 'mirror' })
store.registerProvider(apple)
store.registerProvider(drive)
```

`name` makes each double stand in for a specific provider, so tiering, mirroring and read repair - all of which key off provider names - behave as they will in production.

## Asserting that batching happened

The double records one call per batch, not one per key, so a test can prove the store batched rather than looped:

```ts
const before = provider.calls.getItem
await store.multiGet(['a', 'b', 'c'])
expect(provider.calls.getItem).toBe(before + 1)
```

## Account switches

```ts
provider.emitAccountChange({ status: 'available', identityChanged: true })

expect(store.pendingWrites()).toHaveLength(0)   // the previous user's writes are gone
expect(provider.cacheClears).toBe(1)            // and the provider was told to forget
```

`cacheClears` counts the times the store asked this provider to drop cached state, which is how you check the store reacted rather than merely forwarded the event.

## Mocking the native module

For tests that touch a real provider rather than the in-memory one, mock the native module directly. The package ships the mock this repository uses for its own suite:

```js
// jest.config.js
module.exports = {
  setupFiles: ['react-native-cloud-sync/jest-mock'],
}
```

A `jest.fn()` surface plus an event registry, so tests can fire native events without a device:

```ts
const harness = (global as any).__RNCloudSync

harness.setPlatform('android')                       // exercise the REST branches
harness.emit('accountChange', { status: 'available', identityChanged: true })
harness.setAppState('active')                        // trigger the store's auto-flush
harness.reset()
```

It deliberately avoids `jest.requireActual('react-native')` - loading the real index pulls in DevMenu, whose module-level `TurboModuleRegistry.getEnforcing` call throws under Jest.
