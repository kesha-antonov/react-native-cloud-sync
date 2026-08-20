/**
 * UTF-8 byte length.
 *
 * `String.length` counts UTF-16 code units, which under-reports for any
 * non-ASCII payload - the exact way a "just under the limit" value turns into a
 * server-side rejection.
 *
 * Lives in its own module because both the size-tiering path and the key
 * validator need it, and neither should have to import a REST client to get it.
 */
export function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length

  // Hermes without TextEncoder, and old JSC. `encodeURIComponent` percent-escapes
  // every non-ASCII byte, so counting the escapes counts the UTF-8 bytes.
  let bytes = 0
  const encoded = encodeURIComponent(s)
  for (let i = 0; i < encoded.length; i += 1)
    if (encoded[i] === '%') {
      bytes += 1
      i += 2
    }
    else {
      bytes += 1
    }

  return bytes
}
