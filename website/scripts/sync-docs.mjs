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

const REPO = 'https://github.com/kesha-antonov/react-native-cloud-sync'
// raw.githubusercontent.com resolves LFS-tracked files (like the screenshots
// under assets/) to their actual bytes for a public repo, so pages can embed
// them without copying binaries into website/static and drifting from main.
const RAW = 'https://raw.githubusercontent.com/kesha-antonov/react-native-cloud-sync/main'

/**
 * Canonical key for a heading.
 *
 * GitHub and Docusaurus slugify headings differently (emoji are the painful
 * part), so rather than reimplement either algorithm, reduce both sides to
 * letters and digits. Stable enough to match `#-features` against
 * `## ✨ Features`.
 */
const key = text => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Pages in sidebar order.
 *
 * `sections` pulls named `##` blocks out of README.md; `file` copies a whole
 * markdown file. Either way the repository root stays the single source of
 * truth, so the site cannot drift from what a reader sees on GitHub or npm.
 */
export const PAGES = [
  {
    id: 'intro',
    slug: '/',
    category: 'Getting started',
    title: 'React Native Cloud Sync',
    sidebarLabel: 'Introduction',
    description:
      'iCloud key-value store, CloudKit and Google Drive behind one API for React Native and Expo - '
      + 'on iOS, Android and the web, on both architectures.',
    sections: ['✨ Features', '💡 Why?', '📚 Upstream documentation'],
  },
  {
    id: 'comparison',
    category: 'Getting started',
    title: 'Comparison with other libraries',
    sidebarLabel: 'Comparison',
    description:
      'How this library compares with react-native-cloud-storage, react-native-icloud-kit, expo-cloudkit '
      + 'and expo-icloud-storage across providers, platforms, architectures and error handling.',
    sections: ['⚖️ Comparison'],
  },
  {
    id: 'installation',
    category: 'Getting started',
    title: 'Installation',
    sidebarLabel: 'Installation',
    description: 'Install and configure the library in an Expo or bare React Native project.',
    sections: ['📋 Requirements', '📦 Installation'],
  },
  {
    id: 'choosing-a-provider',
    category: 'Getting started',
    title: 'Choosing a provider',
    sidebarLabel: 'Choosing a provider',
    description:
      'Which of iCloud key-value, CloudKit or Google Drive to use, what each one costs the user, '
      + 'and which combinations make sense for cross-platform apps.',
    file: 'docs/choosing-a-provider.md',
  },
  {
    id: 'example-app',
    category: 'Getting started',
    title: 'Example app',
    sidebarLabel: 'Example app',
    description:
      'A playground app covering every provider, plus a live side-by-side sync demo - what each '
      + 'tab does and screenshots of the running app.',
    sections: ['🧪 Example App'],
  },

  {
    id: 'providers/icloud-kv',
    category: 'Providers',
    title: 'iCloud key-value store',
    sidebarLabel: 'iCloud key-value store',
    description:
      'NSUbiquitousKeyValueStore in React Native: zero-friction sync across a user\'s Apple devices, '
      + 'its 1 MB limits, remote-change and Apple ID switch events.',
    file: 'docs/providers/icloud-kv.md',
  },
  {
    id: 'providers/cloudkit',
    category: 'Providers',
    title: 'CloudKit',
    sidebarLabel: 'CloudKit',
    description:
      'CloudKit records, custom zones and CKAsset uploads from React Native - natively on Apple '
      + 'platforms and over CloudKit Web Services on Android and the web.',
    file: 'docs/providers/cloudkit.md',
  },
  {
    id: 'providers/icloud-drive',
    category: 'Providers',
    title: 'iCloud Drive',
    sidebarLabel: 'iCloud Drive',
    description:
      'Files in the user\'s own iCloud Drive from React Native - visible in Files.app, synced '
      + 'across their Apple devices, and surviving an app uninstall.',
    file: 'docs/providers/icloud-drive.md',
  },
  {
    id: 'providers/google-drive',
    category: 'Providers',
    title: 'Google Drive',
    sidebarLabel: 'Google Drive',
    description:
      "Google Drive's hidden appDataFolder from React Native: identical behaviour on iOS, Android "
      + 'and web, with auth supplied by your app.',
    file: 'docs/providers/google-drive.md',
  },

  {
    id: 'store',
    category: 'Core',
    title: 'The store facade',
    sidebarLabel: 'Store facade',
    description:
      'One API over several providers: size tiering, a durable offline outbox, read fallthrough '
      + 'and migration between clouds.',
    file: 'docs/store.md',
  },
  {
    id: 'errors',
    category: 'Core',
    title: 'Error handling',
    sidebarLabel: 'Error handling',
    description:
      'Typed error codes instead of null: telling "not signed in" from "offline" from "no such key", '
      + 'and deciding when to retry.',
    file: 'docs/errors.md',
  },
  {
    id: 'recipes',
    category: 'Core',
    title: 'Recipes',
    sidebarLabel: 'Recipes',
    description:
      'Backup and restore, safe first-launch restore, pending-sync indicators, Apple ID switches, '
      + 'provider migration and offline-first writes.',
    file: 'docs/recipes.md',
  },
  {
    id: 'encryption',
    category: 'Core',
    title: 'Encryption',
    sidebarLabel: 'Encryption',
    description:
      'What iCloud and Google Drive encrypt for you, CloudKit\'s native end-to-end encryption, '
      + 'and how to add your own with the store\'s codec seam.',
    file: 'docs/encryption.md',
  },
  {
    id: 'hooks',
    category: 'Core',
    title: 'React hooks',
    sidebarLabel: 'React hooks',
    description:
      'useCloudItem, useAccountStatus and usePendingWrites - binding cloud state to components '
      + 'without the stale-response and unmounted-setState bugs.',
    file: 'docs/hooks.md',
  },
  {
    id: 'testing',
    category: 'Core',
    title: 'Testing',
    sidebarLabel: 'Testing',
    description:
      'Fault injection with the in-memory provider, so signed-out, offline, quota-exceeded and '
      + 'account-switch paths are testable in Jest without a device.',
    file: 'docs/testing.md',
  },

  {
    id: 'api',
    category: 'Reference',
    title: 'API Reference',
    sidebarLabel: 'API',
    description: 'Every provider, the facade, the error vocabulary and the test harness.',
    file: 'docs/API.md',
  },
  {
    id: 'platform-notes',
    category: 'Reference',
    title: 'Platform Notes',
    sidebarLabel: 'Platform Notes',
    description: 'iOS entitlements, CloudKit on Android, web support and the two architectures.',
    file: 'docs/PLATFORM_NOTES.md',
  },
  {
    id: 'troubleshooting',
    category: 'Reference',
    title: 'Troubleshooting',
    sidebarLabel: 'Troubleshooting',
    description: 'Common problems and what they usually mean.',
    file: 'docs/troubleshooting.md',
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
/** Source markdown path (e.g. "docs/PLATFORM_NOTES.md") -> page id. */
const idByFile = new Map(
  PAGES.filter(p => p.file != null).map(p => [p.file.replace(/^docs\//, ''), p.id])
)

function rewriteLinks (markdown, ownerByAnchor, page) {
  // Links between doc files are relative on GitHub (../errors.md) but must be
  // site-relative here (/errors). Strip the extension and any leading ../.
  const docLink = markdown.replace(
    /\]\((?:\.\.\/)*((?:providers\/)?[A-Za-z0-9_-]+)\.md(#[a-zA-Z0-9_-]+)?\)/g,
    (whole, target, hash) => {
      const id = idByFile.get(`${target}.md`)
      if (id == null) return whole
      return `](/${id}${hash ?? ''})`
    }
  )

  return docLink
    .replace(/\]\((docs\/[^)]+|example\/[^)]*|LICENSE)\)/g, (_m, path) => `](${REPO}/blob/main/${path})`)
    .replace(/\]\(#([a-z0-9-]+)\)/g, (whole, anchor) => {
      const owner = ownerByAnchor.get(key(anchor))
      return owner == null ? whole : `](${owner})`
    })
    // Raw <img> tags (used for the width/align attributes markdown syntax
    // cannot express) keep repo-relative src on GitHub/npm; the site needs an
    // absolute URL instead.
    .replace(/src="assets\/([^"]+)"/g, (_m, path) => `src="${RAW}/assets/${path}"`)
}

function frontMatter (page) {
  // Docusaurus builds the full document id from the file path, and rejects a
  // slash in the front-matter id - so a nested page declares only its leaf
  // ("cloudkit"), while the sidebar refers to it by path ("providers/cloudkit").
  const leafId = page.id.split('/').pop()

  const lines = [
    '---',
    `id: ${leafId}`,
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

  // Which page owns each README section, so cross-links can be rewritten.
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

    const out = join(OUT, `${page.id}.md`)
    // Nested ids (providers/cloudkit) need their directory to exist.
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, frontMatter(page) + rewriteLinks(body, ownerByAnchor, page) + '\n', 'utf8')
  }

  writeSidebar()

  console.log(`sync-docs: wrote ${PAGES.length} pages to website/docs`)
}

/**
 * Generates sidebars.js from PAGES.
 *
 * Derived rather than hand-maintained: a hand-written sidebar silently drops a
 * page when someone adds one here and forgets the other file.
 */
function writeSidebar () {
  const categories = []
  for (const page of PAGES) {
    const name = page.category ?? 'Docs'
    let group = categories.find(c => c.label === name)
    if (group == null) {
      group = { label: name, items: [] }
      categories.push(group)
    }
    group.items.push(page.id)
  }

  const body = categories
    .map(c => `    {\n      type: 'category',\n      label: ${JSON.stringify(c.label)},\n`
      + `      collapsed: false,\n      items: [${c.items.map(i => `'${i}'`).join(', ')}],\n    },`)
    .join('\n')

  const file = `// GENERATED by scripts/sync-docs.mjs - do not edit.\n`
    + `// Edit the PAGES list in that script instead.\n`
    + `module.exports = {\n  docs: [\n${body}\n  ],\n}\n`

  writeFileSync(join(HERE, '..', 'sidebars.js'), file, 'utf8')
}

// Only generate when run directly. `check-docs-links.mjs` imports PAGES to
// verify the README's absolute site URLs point at pages that exist, and must
// not rewrite website/docs as a side effect of doing so.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1])
  main()
