/* eslint-disable */
// This repo's own setup file. The mock itself lives at the package root as
// `jest-mock.js` so it ships in `files` and consumers can use the exact same
// one via `setupFiles: ['react-native-cloud-sync/jest-mock']` - the docs used
// to point at a file that was never published, which is not a testing story.
require('../jest-mock.js')
