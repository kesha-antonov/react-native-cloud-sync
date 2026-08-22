import { StyleSheet } from 'react-native'

/**
 * Design tokens for the example app - the "Notebook" system.
 *
 * The app's only job is to make every operation, its parameters and its typed
 * result legible - so this palette optimizes for that: a clear front-to-back
 * order of surfaces (bg -> panel -> panelAlt -> panelSunken) so sections and
 * the controls inside them read as layered rather than flat, and semantic
 * tones (ok/warn/error/accent) chosen to stay readable as small text on a
 * pale ground, which is what the log view asks of them constantly.
 *
 * Deliberately light-only, not light/dark-adaptive via useColorScheme() - the
 * same reasoning the previous dark-only palette used, just inverted. HIG
 * expects apps to follow the system appearance, and the honest tradeoff here
 * is: this app is normally run several instances at once - two iOS
 * simulators, an Android emulator, a browser tab - side by side in a single
 * recording or screenshot (see DeviceBanner's comment), specifically so a
 * write on one pane visibly shows up on the others. If each pane's OS
 * happened to be set to a different appearance, the four panes would render
 * in two different palettes and the recording would stop reading as "one
 * consistent app, four devices." A single locked palette is what makes that
 * comparison legible. `app.json`'s `userInterfaceStyle` is set to `"light"`
 * (not `"automatic"`) to make that an explicit app-level choice rather than
 * a mismatch between a manifest that claims to adapt and JS that never did.
 */
export const colors = {
  // Surfaces, lightest to a hair darker - a pale, cool "graph paper" ground.
  bg: '#eef2f4',
  bgElevated: '#e7ecee',
  panel: '#ffffff',
  panelAlt: '#eef2f4',
  panelSunken: '#e2e8ea',

  // Borders.
  border: '#c9d2d6',
  borderStrong: '#a9b5ba',

  // Text.
  text: '#1b2427',
  textDim: '#5a6a70',
  textFaint: '#8b9aa0',

  // Brand accent - "ballpoint ink" blue. `accent` is tuned for readable
  // text/icons on the pale surfaces above; `accentStrong` is a darker fill
  // meant to sit behind near-white text (the "selected" / primary button
  // state) - the same hue can't do both jobs at once and stay AA-legible in
  // each direction. `onAccent` is the text/icon color for that fill.
  accent: '#1f5fa8',
  accentStrong: '#123f73',
  onAccent: '#f4f8fa',
  accentSoft: 'rgba(31, 95, 168, 0.10)',

  // Semantic tones, each with a soft (background tint) variant for badges
  // and log rows.
  ok: '#2f7a4f',
  okSoft: 'rgba(47, 122, 79, 0.12)',
  warn: '#a5710f',
  warnSoft: 'rgba(165, 113, 15, 0.12)',
  error: '#ab3a2c',
  errorSoft: 'rgba(171, 58, 44, 0.12)',
}

/**
 * One identity color per tab, used for its header rail, its section rails,
 * and its dot + label on the tab bar. The point is that "which tab am I on"
 * and "which section did I scroll into" answer themselves visually, using
 * the same shared components everywhere rather than bespoke per-tab styling.
 * Saturated "pen ink" hues, chosen to hold up on white rather than on black.
 */
export const tabTint = {
  sync: '#1f5fa8',
  kv: '#2f7a4f',
  cloudkit: '#6b3fa0',
  drive: '#b9791c',
  files: '#147a72',
  store: '#b1501f',
  faults: '#ab3a2c',
} as const

/**
 * Named weights for the two loaded families (see App.tsx's `useFonts` call).
 * Each expo-google-fonts weight ships as its own font family name, so a
 * custom-font Text style sets `fontFamily` instead of `fontWeight` - mixing
 * the two is unreliable on Android, where `fontWeight` is ignored once a
 * specific-weight family is already selected. Space Mono only ships in
 * regular/bold, so anything wanting a "semibold" mono falls back to bold.
 */
export const fontFamily = {
  ui400: 'LibreFranklin_400Regular',
  ui400Italic: 'LibreFranklin_400Regular_Italic',
  ui500: 'LibreFranklin_500Medium',
  ui600: 'LibreFranklin_600SemiBold',
  ui700: 'LibreFranklin_700Bold',
  ui800: 'LibreFranklin_800ExtraBold',
  mono: 'SpaceMono_400Regular',
  monoBold: 'SpaceMono_700Bold',
} as const

// Kept as a plain alias - most call sites just want "the monospace font"
// without caring which weight.
export const mono = fontFamily.mono

export const radius = {
  sm: 2,
  md: 4,
  lg: 6,
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
    fontFamily: fontFamily.ui800,
    letterSpacing: -0.3,
  },
  h2: {
    color: colors.text,
    fontSize: 15,
    fontFamily: fontFamily.ui700,
  },
  eyebrow: {
    fontSize: 11,
    fontFamily: fontFamily.ui700,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  body: {
    color: colors.textDim,
    fontFamily: fontFamily.ui400,
    fontSize: 13,
    lineHeight: 19,
  },
  caption: {
    color: colors.textFaint,
    fontFamily: fontFamily.ui400,
    fontSize: 11,
    lineHeight: 15,
  },
  mono: {
    color: colors.text,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  monoSmall: {
    color: colors.textDim,
    fontFamily: fontFamily.mono,
    fontSize: 10.5,
  },
})
