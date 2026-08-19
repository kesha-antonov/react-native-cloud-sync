const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')
const { withMetroConfig } = require('react-native-monorepo-config')

// Resolves the library from its source (so edits to ../src hot-reload here)
// via the `source` export condition, while de-duplicating react/react-native
// against this example's copies.
module.exports = withMetroConfig(getDefaultConfig(__dirname), {
  root: path.resolve(__dirname, '..'),
  dirname: __dirname,
})
