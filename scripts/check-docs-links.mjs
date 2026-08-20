// Verifies that the documentation still describes the package that exists.
//
// `check-docs-style.mjs` lints how snippets are written; this checks whether
// what they say is true. Three classes of drift, all of which have happened:
//
//   1. A link or anchor that no longer resolves. Markdown renders a dead
//      relative link as a link - nothing fails until a reader clicks it.
//   2. A README link to the published site pointing at a page or heading the
//      generator does not produce.
//   3. A public export that no page mentions. `WriteMode` was part of
//      `CloudStoreOptions` but absent from both the entry point and the API
//      reference for exactly this reason.
//
// Run with: yarn check:links

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PAGES } from '../website/scripts/sync-docs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SITE = 'https://kesha-antonov.github.io/react-native-cloud-sync'

let problems = 0

function fail(where, message) {
  console.error(`${where}  ${message}`)
  problems += 1
}

/** Every markdown file that is a source of truth (website/docs is generated). */
function markdownFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

const FILES = [join(ROOT, 'README.md'), ...markdownFiles(join(ROOT, 'docs'))]

/**
 * GitHub's heading slug: lowercase, drop everything that is not a word
 * character, space or hyphen, then spaces to hyphens. Emoji vanish, which is
 * why `## ✨ Features` becomes `-features`.
 */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Heading slugs per file, ignoring anything inside a fence. */
function anchorsOf(source) {
  const found = new Set()
  let inFence = false
  for (const line of source.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (heading != null) found.add(slug(heading[1]))
  }
  return found
}

const anchors = new Map(FILES.map(f => [f, anchorsOf(readFileSync(f, 'utf8'))]))

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

// ---------------------------------------------------------------- 1. links

for (const file of FILES) {
  const source = readFileSync(file, 'utf8')
  const where = relative(ROOT, file)

  // Reference-style definitions, so [text][ref] can be resolved to its target.
  const defs = new Map(
    [...source.matchAll(/^\[([^\]]+)\]:\s*(\S+)/gm)].map(m => [m[1].toLowerCase(), m[2]])
  )

  const targets = [
    ...[...source.matchAll(/\]\(([^)\s]+)\)/g)].map(m => ({ url: m[1], index: m.index })),
    ...[...source.matchAll(/\[[^\]\n]+\]\[([^\]\n]+)\]/g)].map(m => ({
      url: defs.get(m[1].toLowerCase()),
      index: m.index,
    })),
  ]

  for (const { url, index } of targets) {
    // A missing reference definition is check-docs-style's job, not this one.
    if (url == null) continue
    if (/^(https?:|mailto:)/.test(url)) continue

    const at = `${where}:${lineOf(source, index)}`
    const [path, hash] = url.split('#')
    const target = path === '' ? file : resolve(dirname(file), path)

    if (path !== '') {
      try {
        statSync(target)
      }
      catch {
        fail(at, `link target does not exist: ${url}`)
        continue
      }
    }

    if (hash == null || hash === '') continue

    const known = anchors.get(target)
    // A link into a non-markdown file (source, example/) carries no anchors we
    // can verify, and that is fine.
    if (known == null) continue
    if (!known.has(hash)) fail(at, `no such heading: ${url}`)
  }
}

// ----------------------------------------------------- 2. published site URLs

const pageIds = new Set(PAGES.map(p => p.id))
/** Site path -> the source file whose headings that page is built from. */
const sourceOfPage = new Map()

for (const page of PAGES) {
  const path = page.slug === '/' ? '' : page.id
  sourceOfPage.set(path, page.file != null ? join(ROOT, page.file) : join(ROOT, 'README.md'))
}

{
  const source = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const pattern = new RegExp(`${SITE}/?([^)\\s"']*)`, 'g')

  for (const m of source.matchAll(pattern)) {
    const at = `README.md:${lineOf(source, m.index)}`
    const [path, hash] = m[1].split('#')

    if (path !== '' && !pageIds.has(path)) {
      fail(at, `no such site page: /${path} (not in sync-docs PAGES)`)
      continue
    }

    if (hash == null || hash === '') continue

    const known = anchors.get(sourceOfPage.get(path))
    if (known != null && !known.has(hash)) fail(at, `no such heading on /${path}: #${hash}`)
  }
}

// ------------------------------------------------------- 3. undocumented API

/** Named exports of the public entry point, values and types alike. */
function publicExports() {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const names = new Set()

  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g))
    for (const part of block[1].split(',')) {
      // `sync as icloudKVSync` is exported under the alias; `type Foo` in a
      // mixed clause carries an inline modifier to strip.
      const cleaned = part.trim().replace(/^type\s+/, '')
      if (cleaned === '') continue
      const alias = /\sas\s+(\S+)$/.exec(cleaned)
      names.add(alias != null ? alias[1] : cleaned)
    }

  return names
}

{
  // Every doc, not just API.md: a provider guide documenting an export counts.
  const prose = FILES.map(f => readFileSync(f, 'utf8')).join('\n')

  for (const name of publicExports()) {
    // Word-boundary match, so `googleDrive` does not satisfy `googleDriveFiles`.
    const mentioned = new RegExp(`\\b${name}\\b`).test(prose)
    if (!mentioned) fail('src/index.ts', `export is documented nowhere: ${name}`)
  }
}

// ----------------------------------------------------------------- report

if (problems > 0) {
  console.error(`\ndocs link check FAILED: ${problems} problem(s)`)
  process.exit(1)
}

console.log(`docs link check passed (${FILES.length} files, ${pageIds.size} site pages)`)
