import { StyleSheet, Text, TextInput, View } from 'react-native'

import { colors, mono } from '../theme'

interface Props {
  label: string
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  multiline?: boolean
}

export function Field({ label, value, onChangeText, placeholder, multiline }: Props) {
  return (
    <View style={s.wrap}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={[s.input, multiline === true && s.multiline]}
      />
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { gap: 4 },
  label: {
    color: colors.textDim,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text,
    fontFamily: mono,
    fontSize: 12,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
})
