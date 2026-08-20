/// <reference types="node" />
import { base64ToBytes, bytesToBase64 } from '../internal/base64'

// Node's `Buffer` is a trustworthy oracle here - it is never used by the
// package itself (Hermes has no `Buffer`, which is why this file exists at
// all), only by the test that checks this implementation against it. The
// triple-slash reference pulls in its type just for this file, rather than
// widening tsconfig's `types` (deliberately `["jest"]` only) project-wide.
const reference = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

describe('bytesToBase64', () => {
  it('matches a trusted encoder across every padding case', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 100, 257]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 256)
      expect(bytesToBase64(bytes)).toBe(reference(bytes))
    }
  })

  it('covers every byte value, not just a small sample', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(bytesToBase64(bytes)).toBe(reference(bytes))
  })
})

describe('base64ToBytes', () => {
  it('round-trips through bytesToBase64 for every padding case', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 100, 257]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 7) % 256)
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    }
  })

  it('decodes what a trusted encoder produced', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(base64ToBytes(reference(bytes))).toEqual(bytes)
  })

  it('ignores embedded whitespace, which some fs libraries insert into long strings', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6])
    const withNewlines = bytesToBase64(bytes).replace(/(.{4})/g, '$1\n')
    expect(base64ToBytes(withNewlines)).toEqual(bytes)
  })
})
