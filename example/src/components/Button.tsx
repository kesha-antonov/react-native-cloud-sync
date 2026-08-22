import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import { colors, fontFamily, radius } from '../theme'

interface Props {
  label: string
  onPress: () => void
  tone?: 'default' | 'danger' | 'primary'
  selected?: boolean
  busy?: boolean
  disabled?: boolean
}

/**
 * The one button used everywhere - operations, provider pickers, "Clear".
 *
 * `selected` is visually distinct from `disabled`, which used to be
 * overloaded for both: a selected provider chip in the Sync tab reused the
 * disabled/dimmed style, which reads as "broken", not "active". Selected
 * (and `tone="primary"`) fill solid with the accent color; disabled stays a
 * flat dim, same as before.
 */
export function Button({ label, onPress, tone = 'default', selected, busy, disabled }: Props) {
  const isDisabled = disabled === true || busy === true
  const filled = selected === true || tone === 'primary'
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        s.button,
        tone === 'danger' && s.danger,
        filled && s.filled,
        pressed && s.pressed,
        isDisabled && !filled && s.disabled,
      ]}
    >
      {busy === true
        ? <ActivityIndicator size="small" color={colors.text} />
        : <Text style={[s.label, filled && s.labelFilled]}>{label}</Text>}
    </Pressable>
  )
}

export function ButtonRow({ children }: { children: React.ReactNode }) {
  return <View style={s.row}>{children}</View>
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  button: {
    backgroundColor: colors.panelAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 14,
    minHeight: 44, // HIG's minimum comfortable tap target
    justifyContent: 'center',
    alignItems: 'center',
  },
  danger: {
    borderColor: colors.error,
  },
  filled: {
    backgroundColor: colors.accentStrong,
    borderColor: colors.accentStrong,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontFamily: fontFamily.ui600,
  },
  labelFilled: {
    color: colors.onAccent,
  },
})
