# Testing

Cloud storage is the hardest part of a mobile app to test honestly - the most-used library here [gave up testing iCloud on the simulator entirely](https://github.com/kuatsu/react-native-cloud-storage/issues/41). This package ships an in-memory provider with fault injection instead, from a real entry point:

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

Asserts your backoff honours the server's hint, not its own schedule.

## Simulating other devices

```ts
provider.emitRemoteChange({ keys: ['user/id'], reason: 'serverChange' })
```

The cross-user leak case:

```ts
provider.emitAccountChange({ status: 'available', identityChanged: true })
// Assert that every user-scoped cache was dropped.
```

## Asserting call counts

```ts
expect(provider.calls.setItem).toBe(1)   // no blind second write
```

Proves a retry did *not* happen - e.g. a quota failure surfacing instead of queuing forever.

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

`setAvailable(false)` flips it mid-test - for a mid-session sign-out.

## Faults scoped to one key

Real backends fail per record, not per operation - one bad key, the rest of the batch through:

```ts
const provider = createMemoryProvider({
  faults: {
    setItem: { code: ErrorCode.QUOTA_EXCEEDED, only: key => key === 'huge' },
  },
})
```

Also keeps interleaving tests deterministic - in-flight operations no longer share a `times` budget.

## Several providers at once

```ts
const apple = createMemoryProvider({ name: 'icloudKV' })
const drive = createMemoryProvider({ name: 'googleDrive' })

const store = createCloudStore({ providers: ['icloudKV', 'googleDrive'], writeMode: 'mirror' })
store.registerProvider(apple)
store.registerProvider(drive)
```

`name` makes each double stand in for a real provider - tiering, mirroring and read repair, which key off names, behave as in production.

## Asserting that batching happened

The double counts one call per batch, not per key, proving the store batched rather than looped:

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

`cacheClears` counts how often the store told this provider to drop cached state - proof it reacted, not just forwarded the event.

## Mocking the native module

To test a real provider, mock the native module directly - this package ships the mock its own suite uses:

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
