import { type ReactNode } from 'react'
import { Platform, View } from 'react-native'
import { SymbolView, type SymbolWeight } from 'expo-symbols'
import type { SFSymbol } from 'sf-symbols-typescript'

interface Props {
  name: SFSymbol
  size?: number
  color: string
  weight?: SymbolWeight
}

/**
 * Real SF Symbols, via expo-symbols' native `SymbolView` - not a third-party
 * icon font standing in for them. expo-symbols is the Expo SDK's own module
 * (`57.0.2`, matching this app's SDK 57 exactly) and its iOS/macOS side
 * renders actual SF Symbols through SwiftUI, which is what HIG tab bars and
 * list rows expect.
 *
 * expo-symbols also ships a Material Symbols renderer for Android/web, but
 * using it means curating a second, differently-named icon set (Material
 * Symbol names don't match SF Symbol names) and pulling in font loading
 * (`expo-font`, `@expo-google-fonts/material-symbols`) purely for a
 * secondary platform - see the scope note in App.tsx: this app is iOS-first
 * in practice, since CloudKit/iCloud are Apple-only and Android/web exist
 * mainly to prove googleDriveFiles/googleDrive still work. So non-Apple
 * platforms fall back to a plain tinted dot here: the same "one identity
 * color" language already used by the tab bar's dots (before this pass) and
 * by Header/Section's colored rails, rather than a mismatched substitute
 * icon set.
 */
export function IconSymbol({ name, size = 22, color, weight = 'regular' }: Props): ReactNode {
  if (Platform.OS === 'ios' || Platform.OS === 'macos')
    return (
      <SymbolView
        name={name}
        size={size}
        tintColor={color}
        weight={weight}
        resizeMode="scaleAspectFit"
        style={{ width: size, height: size }}
      />
    )
  const dot = size * 0.34
  return <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
}
