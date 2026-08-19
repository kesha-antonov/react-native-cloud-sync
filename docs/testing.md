# Testing

Cloud storage is the hardest part of a mobile app to test honestly. iCloud on the simulator is unreliable enough that the most-used library in this space [stopped testing on it entirely](https://github.com/kuatsu/react-native-cloud-storage/issues/41) and recommends real devices only - which means the failure paths that matter most are the ones never exercised.

So this package ships an in-memory provider with fault injection, from a real entry point:

```ts
import { createMemoryProvider } from '@kesha-antonov/react-native-cloud-sync/testing'
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
import { ErrorCode } from '@kesha-antonov/react-native-cloud-sync'

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

## Mocking the native module

For tests that touch a real provider rather than the in-memory one, mock the native module directly. This repository's own `__mocks__/RNCloudSync.js` is a working example: a `jest.fn()` surface plus an event registry, so tests can fire native events without a device.

It deliberately avoids `jest.requireActual('react-native')` - loading the real index pulls in DevMenu, whose module-level `TurboModuleRegistry.getEnforcing` call throws under Jest.
