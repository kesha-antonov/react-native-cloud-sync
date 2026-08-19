/**
 * Autolinking configuration.
 *
 * iOS links the pod (CloudKit + NSUbiquitousKeyValueStore, both native).
 *
 * Android is deliberately `null` - this package ships no Android native code.
 * CloudKit is reached from Android over CloudKit Web Services REST, and that
 * client lives in TypeScript (`src/internal/cloudKitRest.ts`) because the exact
 * same code serves the web build. Writing it a second time in Kotlin would
 * duplicate the auth handling and error mapping - the two places bugs in this
 * area actually live - for no capability gain. Google Drive is REST for the
 * same reason, on every platform.
 */
module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: null,
    },
  },
}
