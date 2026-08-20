import { type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { space, styles as shared } from '../theme'

interface Props {
  eyebrow: string
  title: string
  description: ReactNode
  tint: string
}

/**
 * The banner at the top of every tab.
 *
 * Every tab used to open with an identical, unlabeled stack of a heading and
 * a paragraph, which is a big part of why scrolling through the app felt
 * like one long undifferentiated document. The color rail + eyebrow give
 * each tab a distinct identity that also shows up on the tab bar below, so
 * "which screen is this" and "which tab am I on" share one visual language.
 */
export function TabHeader({ eyebrow, title, description, tint }: Props) {
  return (
    <View style={s.wrap}>
      <View style={[s.bar, { backgroundColor: tint }]} />
      <View style={s.text}>
        <Text style={[shared.eyebrow, { color: tint }]}>{eyebrow}</Text>
        <Text style={shared.h1}>{title}</Text>
        <Text style={shared.body}>{description}</Text>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    gap: space.md,
  },
  bar: {
    width: 4,
    borderRadius: 2,
  },
  text: {
    flex: 1,
    gap: 6,
  },
})
