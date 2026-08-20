/**
 * The `GoogleDriveFileAdapter` reference implementation, on modern
 * `expo-file-system`.
 *
 * `googleDriveFiles` deliberately has no filesystem dependency of its own - it
 * is the one API in this package that needs the host app to supply I/O. That
 * makes it the one API most likely to be wired up wrong, which is why the
 * example app carries a working version rather than leaving it to the docs.
 *
 * The contract is base64 in and base64 out, while `FileHandle` works in
 * `Uint8Array`, so `bytesToBase64`/`base64ToBytes` (exported from this package,
 * dependency-free and Hermes-safe) bridge the two.
 */

import { File, Paths } from 'expo-file-system'

import { base64ToBytes, bytesToBase64, configureGoogleDriveFiles } from 'react-native-cloud-sync'

export function installExpoFileAdapter() {
  configureGoogleDriveFiles({
    statSize: async uri => new File(uri).size,

    readChunk: async (uri, position, length) => {
      const handle = new File(uri).open()
      try {
        // A seekable handle is the whole point: a chunk costs its own bytes and
        // nothing more, so a 500 MB file never lands in memory as a string.
        handle.offset = position
        return bytesToBase64(handle.readBytes(length))
      }
      finally {
        // An open handle blocks the file from being moved or deleted.
        handle.close()
      }
    },

    writeChunk: async (uri, base64) => {
      const file = new File(uri)
      file.create({ intermediates: true, overwrite: true })
      const handle = file.open()
      try {
        handle.writeBytes(base64ToBytes(base64))
      }
      finally {
        handle.close()
      }
    },

    appendChunk: async (uri, base64) => {
      const handle = new File(uri).open()
      try {
        handle.offset = handle.size ?? 0
        handle.writeBytes(base64ToBytes(base64))
      }
      finally {
        handle.close()
      }
    },
  })
}

/**
 * A URI in the cache directory, joined by `File` rather than by concatenation -
 * `Directory.uri` carrying (or not carrying) a trailing slash is not something
 * to guess at.
 */
export function scratchUri(name: string): string {
  return new File(Paths.cache, name).uri
}

/**
 * Writes a file of `megabytes` pseudo-random bytes, for exercising a transfer
 * large enough that chunking and progress actually mean something.
 */
export function makeTestFile(name: string, megabytes: number): string {
  const file = new File(Paths.cache, name)
  file.create({ intermediates: true, overwrite: true })

  const handle = file.open()
  try {
    const block = new Uint8Array(1024 * 1024)
    for (let i = 0; i < block.length; i++) block[i] = i & 0xff
    for (let mb = 0; mb < megabytes; mb++) handle.writeBytes(block)
  }
  finally {
    handle.close()
  }

  return file.uri
}

export function fileSize(uri: string): number {
  return new File(uri).size
}

export function deleteIfPresent(uri: string): void {
  const file = new File(uri)
  if (file.exists) file.delete()
}
