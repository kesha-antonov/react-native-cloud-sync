import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import { colors } from '../theme'

interface Props {
  label: string
  onPress: () => void
  tone?: 'default' | 'danger'
  busy?: boolean
  disabled?: boolean
}

export function Button({ label, onPress, tone = 'default', busy, disabled }: Props) {
  const isDisabled = disabled === true || busy === true
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        s.button,
        tone === 'danger' && s.danger,
        pressed && s.pressed,
        isDisabled && s.disabled,
      ]}
    >
      {busy === true
        ? <ActivityIndicator size="small" color={colors.text} />
        : <Text style={s.label}>{label}</Text>}
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
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 14,
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
  },
  danger: {
    borderColor: colors.error,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '500',
  },
})
