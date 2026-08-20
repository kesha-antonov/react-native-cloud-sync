import { Platform, StyleSheet } from 'react-native'

/**
 * Design tokens for the example app.
 *
 * The app's only job is to make every operation, its parameters and its typed
 * result legible - so this palette optimizes for that: a clear front-to-back
 * order of surfaces (bg -> panel -> panelAlt -> panelSunken) so sections and
 * the controls inside them read as layered rather than flat, and semantic
 * tones (ok/warn/error/accent) chosen to stay readable as small text on a
 * dark background, which is what the log view asks of them constantly.
 *
 * Deliberately dark-only, not light/dark-adaptive via useColorScheme(). HIG
 * expects apps to follow the system appearance, and the honest tradeoff here
 * is: this app is normally run several instances at once - two iOS
 * simulators, an Android emulator, a browser tab - side by side in a single
 * recording or screenshot (see DeviceBanner's comment), specifically so a
 * write on one pane visibly shows up on the others. If each pane's OS
 * happened to be set to a different appearance, the four panes would render
 * in two different palettes and the recording would stop reading as "one
 * consistent app, four devices." A single locked palette is what makes that
 * comparison legible. `app.json`'s `userInterfaceStyle` is set to `"dark"`
 * (not `"automatic"`) to make that an explicit app-level choice rather than
 * a mismatch between a manifest that claims to adapt and JS that never did.
 * Retrofitting real light/dark support would also mean converting every
 * `StyleSheet.create` that references these tokens - all five shared
 * components plus each tab file's local styles - from static values to a
 * live theme hook, which is a broad mechanical rewrite for a tool whose
 * audience is library developers, not end users bothered by a fixed theme.
 */
export const colors = {
  // Surfaces, darkest to lightest.
  bg: '#0b0e15',
  bgElevated: '#10141d',
  panel: '#151a24',
  panelAlt: '#1c2330',
  panelSunken: '#0d1119',

  // Borders.
  border: '#262e3d',
  borderStrong: '#3a4457',

  // Text.
  text: '#eef2f8',
  textDim: '#8b94a8',
  textFaint: '#7a8496',

  // Brand accent. `accent` is tuned for readable text/icons on the dark
  // surfaces above; `accentStrong` is a darker fill meant to sit behind
  // near-white text (the "selected" / primary button state) - the same hue
  // can't do both jobs at once and stay AA-legible in each direction.
  accent: '#5b8cf5',
  accentStrong: '#3960d6',
  accentSoft: 'rgba(91, 140, 245, 0.16)',

  // Semantic tones, each with a soft (background tint) variant for badges
  // and log rows.
  ok: '#3ecb7a',
  okSoft: 'rgba(62, 203, 122, 0.14)',
  warn: '#e2a53a',
  warnSoft: 'rgba(226, 165, 58, 0.14)',
  error: '#f8574f',
  errorSoft: 'rgba(248, 87, 79, 0.14)',
}

/**
 * One identity color per tab, used for its header rail, its section rails,
 * and its dot + label on the tab bar. The point is that "which tab am I on"
 * and "which section did I scroll into" answer themselves visually, using
 * the same shared components everywhere rather than bespoke per-tab styling.
 */
export const tabTint = {
  sync: '#5b8cf5',
  kv: '#3ecb7a',
  cloudkit: '#b285f0',
  drive: '#f2b84b',
  files: '#3ecbc0',
  store: '#f5866a',
  faults: '#f8574f',
} as const

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
})

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
}

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
}

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    paddingBottom: 56,
    gap: space.lg,
  },
  h1: {
    color: colors.text,
    fontSize: 23,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  h2: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  body: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
  caption: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 15,
  },
  mono: {
    color: colors.text,
    fontFamily: mono,
    fontSize: 12,
  },
  monoSmall: {
    color: colors.textDim,
    fontFamily: mono,
    fontSize: 10.5,
  },
})
