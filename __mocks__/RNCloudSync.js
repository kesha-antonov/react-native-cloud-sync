/* eslint-disable */
// Hand-built native mock, following react-native-background-downloader's
// __mocks__ pattern: a jest.fn() surface plus an event registry so tests can
// fire native events without a device.
//
// Deliberately does NOT `jest.requireActual('react-native')`. Loading the real
// RN index pulls in DevMenu, whose module-level TurboModuleRegistry.getEnforcing
// call throws under Jest. The library only touches four RN exports, so provide
// exactly those.

const eventCallbacks = {}

const mockModule = {
  getConstants: jest.fn(() => ({
    containerIdentifier: 'iCloud.test.container',
    hasICloudEntitlement: true,
  })),

  getAccountStatus: jest.fn(() => Promise.resolve('available')),
  isAvailable: jest.fn(() => Promise.resolve(true)),

  kvGetItem: jest.fn(() => Promise.resolve(null)),
  kvSetItem: jest.fn(() => Promise.resolve()),
  kvRemoveItem: jest.fn(() => Promise.resolve()),
  kvGetAllKeys: jest.fn(() => Promise.resolve([])),
  kvSync: jest.fn(() => Promise.resolve(true)),

  ckGetRecord: jest.fn(() => Promise.resolve(null)),
  ckSaveRecord: jest.fn(() => Promise.resolve()),
  ckDeleteRecord: jest.fn(() => Promise.resolve(true)),
  ckQueryRecordNames: jest.fn(() => Promise.resolve([])),
  ckCreateZone: jest.fn(() => Promise.resolve()),
  ckDeleteZone: jest.fn(() => Promise.resolve()),
  ckListZones: jest.fn(() => Promise.resolve([])),
  ckSaveAsset: jest.fn(() => Promise.resolve()),
  ckFetchAsset: jest.fn(() => Promise.resolve(null)),

  setLogsEnabled: jest.fn(),

  addListener: jest.fn(),
  removeListeners: jest.fn(),
}

class MockNativeEventEmitter {
  addListener (name, cb) {
    eventCallbacks[name] = eventCallbacks[name] ?? []
    eventCallbacks[name].push(cb)
    return {
      remove: () => {
        eventCallbacks[name] = (eventCallbacks[name] ?? []).filter(c => c !== cb)
      },
    }
  }

  removeAllListeners (name) {
    delete eventCallbacks[name]
  }
}

// `platform` is mutable so a test can exercise the Android/web branches.
const state = { platform: 'ios', turboModule: null }

jest.mock('react-native', () => ({
  get Platform () {
    return { OS: state.platform, select: objs => objs[state.platform] ?? objs.default }
  },
  NativeModules: { RNCloudSync: mockModule },
  TurboModuleRegistry: {
    get: () => state.turboModule,
    getEnforcing: () => {
      if (state.turboModule == null) throw new Error('TurboModule RNCloudSync not found')
      return state.turboModule
    },
  },
  NativeEventEmitter: MockNativeEventEmitter,
}))

global.__RNCloudSync = {
  module: mockModule,
  /** Fire a native event, as the old-architecture emitter would. */
  emit (name, payload) {
    for (const cb of eventCallbacks[name] ?? []) cb(payload)
  },
  /** Switch the reported platform for a test. */
  setPlatform (os) {
    state.platform = os
  },
  /** Run the new-architecture code path instead of the bridge one. */
  setTurboModule (m) {
    state.turboModule = m
  },
  reset () {
    for (const key of Object.keys(eventCallbacks)) delete eventCallbacks[key]
    state.platform = 'ios'
    state.turboModule = null
  },
}
