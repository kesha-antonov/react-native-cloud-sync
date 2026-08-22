import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'

import { colors, fontFamily, mono, radius } from '../theme'

interface Props {
  label: string
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  multiline?: boolean
  testID?: string
}

export function Field({ label, value, onChangeText, placeholder, multiline, testID }: Props) {
  const [focused, setFocused] = useState(false)

  return (
    <View style={s.wrap}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[s.input, multiline === true && s.multiline, focused && s.inputFocused]}
      />
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { gap: 5 },
  label: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fontFamily.ui600,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: colors.panelSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: colors.text,
    fontFamily: mono,
    fontSize: 12,
  },
  inputFocused: {
    borderColor: colors.accent,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
})
