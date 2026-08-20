import { Platform, StyleSheet, Text, View } from 'react-native'

import { colors, mono } from '../theme'
import { deviceLabel } from '../deviceId'

/**
 * Identifies which pane is which in a side-by-side recording.
 *
 * With four panes (two iOS simulators, an Android emulator and a browser) all
 * showing the same UI, a screen recording is unreadable without this. Sits in
 * the app's top bar next to the wordmark - the top bar itself owns the outer
 * chrome and border.
 */
export function DeviceBanner() {
  return (
    <View style={s.pill}>
      <View style={[s.dot, { backgroundColor: PLATFORM_COLOR[Platform.OS] ?? colors.textDim }]} />
      <Text style={s.text}>{deviceLabel()}</Text>
    </View>
  )
}

const PLATFORM_COLOR: Record<string, string> = {
  ios: '#5b8cf5',
  android: '#3ecb7a',
  web: '#e2a53a',
  macos: '#b285f0',
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.panelAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    color: colors.textDim,
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '600',
  },
})
