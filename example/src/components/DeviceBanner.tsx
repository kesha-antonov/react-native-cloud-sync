import { Platform, StyleSheet, Text, View } from 'react-native'

import { colors, mono } from '../theme'
import { deviceLabel } from '../deviceId'

/**
 * Identifies which pane is which in a side-by-side recording.
 *
 * With four panes (two iOS simulators, an Android emulator and a browser) all
 * showing the same UI, a screen recording is unreadable without this.
 */
export function DeviceBanner() {
  return (
    <View style={s.wrap}>
      <View style={[s.dot, { backgroundColor: PLATFORM_COLOR[Platform.OS] ?? colors.textDim }]} />
      <Text style={s.text}>{deviceLabel()}</Text>
    </View>
  )
}

const PLATFORM_COLOR: Record<string, string> = {
  ios: '#58a6ff',
  android: '#3fb950',
  web: '#d29922',
  macos: '#bc8cff',
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.panelAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  text: {
    color: colors.text,
    fontFamily: mono,
    fontSize: 11,
  },
})
