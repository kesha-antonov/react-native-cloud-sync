import { Platform, StyleSheet } from 'react-native'

export const colors = {
  bg: '#0d1117',
  panel: '#161b22',
  panelAlt: '#1c2129',
  border: '#30363d',
  text: '#e6edf3',
  textDim: '#8b949e',
  accent: '#58a6ff',
  ok: '#3fb950',
  warn: '#d29922',
  error: '#f85149',
}

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
})

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 16,
  },
  h1: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  body: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
  mono: {
    color: colors.text,
    fontFamily: mono,
    fontSize: 12,
  },
})
