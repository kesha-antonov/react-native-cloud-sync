import { type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { colors } from '../theme'

interface Props {
  title: string
  subtitle?: string
  children: ReactNode
}

export function Section({ title, subtitle, children }: Props) {
  return (
    <View style={s.card}>
      <Text style={s.title}>{title}</Text>
      {subtitle != null && <Text style={s.subtitle}>{subtitle}</Text>}
      <View style={s.body}>{children}</View>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  body: {
    gap: 8,
    marginTop: 4,
  },
})
