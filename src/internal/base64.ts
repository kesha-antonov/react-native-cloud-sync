/**
 * Base64 encode/decode for the Drive binary-file path.
 *
 * Hand-rolled rather than `Buffer` or `atob`/`btoa`: neither is guaranteed to
 * exist in a Hermes runtime, and this package ships with zero runtime
 * dependencies (see `googleDriveFiles` for why - the file adapter itself is
 * injected, in base64, for the same reason). A chunk is a few MB at most, so a
 * lookup-table implementation is fast enough without needing a native module.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `CHARS[c]` -> its 6-bit value, indexed by char code. -1 for anything else. */
const DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < CHARS.length; i++) table[CHARS.charCodeAt(i)] = i
  return table
})()

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const len = bytes.length

  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const hasB1 = i + 1 < len
    const hasB2 = i + 2 < len
    const b1 = hasB1 ? bytes[i + 1] : 0
    const b2 = hasB2 ? bytes[i + 2] : 0

    chunks.push(
      CHARS[b0 >> 2],
      CHARS[((b0 & 0x03) << 4) | (b1 >> 4)],
      hasB1 ? CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=',
      hasB2 ? CHARS[b2 & 0x3f] : '='
    )
  }

  return chunks.join('')
}

export function base64ToBytes(base64: string): Uint8Array {
  // Strip whitespace some fs libraries insert into long base64 strings, and
  // any padding - length is derived from the real character count instead.
  const clean = base64.replace(/[\r\n\s]/g, '').replace(/=+$/, '')
  const len = clean.length
  const outLen = Math.floor((len * 3) / 4)
  const bytes = new Uint8Array(outLen)

  let p = 0
  for (let i = 0; i < len; i += 4) {
    const e0 = DECODE_TABLE[clean.charCodeAt(i)] ?? -1
    const e1 = i + 1 < len ? DECODE_TABLE[clean.charCodeAt(i + 1)] ?? -1 : -1
    const e2 = i + 2 < len ? DECODE_TABLE[clean.charCodeAt(i + 2)] ?? -1 : -1
    const e3 = i + 3 < len ? DECODE_TABLE[clean.charCodeAt(i + 3)] ?? -1 : -1

    if (p < outLen) bytes[p++] = (e0 << 2) | (e1 >> 4)
    if (p < outLen) bytes[p++] = ((e1 & 0x0f) << 4) | (e2 >> 2)
    if (p < outLen) bytes[p++] = ((e2 & 0x03) << 6) | e3
  }

  return bytes
}
