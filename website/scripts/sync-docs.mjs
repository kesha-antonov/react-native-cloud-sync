// Generates the Docusaurus pages from the markdown that already lives in the
// repository root, so README.md and docs/*.md stay the single source of truth
// and the site can never drift away from them.
//
// Run via `yarn sync` (also runs automatically before `start` and `build`).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, '..', 'docs')

const REPO = 'https://github.com/kesha-antonov/react-native-cloud-storage'

/**
 * Canonical key for a heading.
 *
 * GitHub and Docusaurus slugify headings differently (emoji are the painful
 * part), so rather than reimplement either algorithm, reduce both sides to
 * letters and digits. Stable enough to match `#-features` against
 * `## ✨ Features`.
 */
const key = text => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Pages in sidebar order. `sections` pulls from README; `file` copies whole. */
const PAGES = [
  {
    id: 'intro',
    slug: '/',
    title: 'React Native Cloud Storage',
    sidebarLabel: 'Introduction',
    description:
      'iCloud key-value store, CloudKit and Google Drive behind one API for React Native and Expo - '
      + 'on iOS, Android and the web, on both architectures.',
    sections: ['✨ Features', '💡 Why?'],
  },
  {
    id: 'comparison',
    title: 'Comparison with other libraries',
    sidebarLabel: 'Comparison',
    description:
      'How this library compares with react-native-cloud-storage, react-native-icloud-kit, expo-cloudkit '
      + 'and expo-icloud-storage across providers, platforms, architectures and error handling.',
    sections: ['⚖️ Comparison'],
  },
  {
    id: 'installation',
    title: 'Installation',
    sidebarLabel: 'Installation',
    description: 'Install and configure the library in an Expo or bare React Native project.',
    sections: ['📋 Requirements', '📦 Installation'],
  },
  {
    id: 'usage',
    title: 'Usage',
    sidebarLabel: 'Usage',
    description: 'Reading and writing values, reacting to remote changes, and handling failures.',
    sections: ['🚀 Usage', '⚙️ Advanced Configuration'],
  },
  {
    id: 'api',
    title: 'API Reference',
    sidebarLabel: 'API',
    description: 'Every provider, the facade, the error vocabulary and the test harness.',
    file: 'docs/API.md',
  },
  {
    id: 'platform-notes',
    title: 'Platform Notes',
    sidebarLabel: 'Platform Notes',
    description: 'iOS entitlements, CloudKit on Android, web support and the two architectures.',
    file: 'docs/PLATFORM_NOTES.md',
  },
  {
    id: 'testing',
    title: 'Testing',
    sidebarLabel: 'Testing',
    description: 'Fault injection with the in-memory provider, so failure paths are actually testable.',
    sections: ['🧪 Testing'],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    sidebarLabel: 'Troubleshooting',
    description: 'Common problems and what they usually mean.',
    sections: ['❓ Troubleshooting', '🧪 Example App'],
  },
]

/** Splits a markdown document into `## ` sections keyed by canonical heading. */
function splitSections (markdown) {
  const lines = markdown.split('\n')
  const sections = new Map()
  let current = null
  let buffer = []
  let inFence = false

  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence

    const match = !inFence && /^## (.+)$/.exec(line)
    if (match) {
      if (current != null) sections.set(current, buffer.join('\n').trim())
      current = key(match[1])
      buffer = [line]
      continue
    }
    if (current != null) buffer.push(line)
  }
  if (current != null) sections.set(current, buffer.join('\n').trim())
  return sections
}

/**
 * Rewrites links that only make sense on GitHub.
 * Relative repo paths become absolute GitHub URLs; in-README anchors become
 * site-relative links to whichever page now owns that section.
 */
function rewriteLinks (markdown, ownerByAnchor) {
  return markdown
    .replace(/\]\((docs\/[^)]+|example\/[^)]*|LICENSE)\)/g, (_m, path) => `](${REPO}/blob/main/${path})`)
    .replace(/\]\(#([a-z0-9-]+)\)/g, (whole, anchor) => {
      const owner = ownerByAnchor.get(key(anchor))
      return owner == null ? whole : `](${owner})`
    })
}

function frontMatter (page) {
  const lines = [
    '---',
    `id: ${page.id}`,
    `title: ${JSON.stringify(page.title)}`,
    `sidebar_label: ${JSON.stringify(page.sidebarLabel)}`,
    `description: ${JSON.stringify(page.description)}`,
  ]
  if (page.slug != null) lines.push(`slug: ${page.slug}`)
  lines.push('---', '')
  return lines.join('\n')
}

function main () {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const sections = splitSections(readme)

  // Which page will own each README section, so cross-links can be rewritten.
  const ownerByAnchor = new Map()
  for (const page of PAGES) {
    const target = page.slug ?? `/${page.id}`
    for (const heading of page.sections ?? []) ownerByAnchor.set(key(heading), target)
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  for (const page of PAGES) {
    let body

    if (page.file != null) {
      const raw = readFileSync(join(ROOT, page.file), 'utf8')
      // Drop the leading H1 - the front matter title supplies it.
      body = raw.replace(/^#\s+.+\n/, '').trim()
    } else {
      const parts = []
      for (const heading of page.sections ?? []) {
        const found = sections.get(key(heading))
        if (found == null) throw new Error(`README section not found: "${heading}" (page ${page.id})`)
        parts.push(found)
      }
      body = parts.join('\n\n')
    }

    const content = frontMatter(page) + rewriteLinks(body, ownerByAnchor) + '\n'
    writeFileSync(join(OUT, `${page.id}.md`), content, 'utf8')
  }

  console.log(`sync-docs: wrote ${PAGES.length} pages to website/docs`)
}

main()
