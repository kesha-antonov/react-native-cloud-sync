// @ts-check
const { themes } = require('prism-react-renderer')
const { execFileSync } = require('node:child_process')

const REPO = 'https://github.com/kesha-antonov/react-native-cloud-sync'
const SITE = 'https://kesha-antonov.com/react-native-cloud-sync/'
const TAGLINE = 'iCloud key-value store, CloudKit, iCloud Drive and Google Drive behind one API - iOS, Android and web'

// Describes the library to search engines on every page.
const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  'name': 'React Native Cloud Sync',
  'description': TAGLINE,
  'url': SITE,
  'codeRepository': REPO,
  'programmingLanguage': 'TypeScript',
  'runtimePlatform': 'React Native',
  'license': 'https://spdx.org/licenses/MIT',
  'author': { '@type': 'Person', 'name': 'Kesha Antonov', 'url': 'https://kesha-antonov.com/' },
}

// The docs pages are generated from the README and the docs folder at build
// time, so git has no date for the pages themselves. The sitemap takes the date
// of the last commit that touched their sources. Without git history (a tarball,
// a shallow clone with no match) the dates are left out.
function docsLastModified() {
  try {
    const date = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', '../README.md', '../docs', '../MIGRATION.md', '.'],
      { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
  }
  catch {
    return undefined
  }
}
const LASTMOD = docsLastModified()

// Every page gets that one date.
const sitemapWithDates = {
  createSitemapItems: async ({ defaultCreateSitemapItems, ...rest }) => {
    const items = await defaultCreateSitemapItems(rest)
    return LASTMOD ? items.map(item => ({ ...item, lastmod: LASTMOD })) : items
  },
}

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'React Native Cloud Sync',
  tagline: TAGLINE,
  favicon: 'https://kesha-antonov.com/favicon.ico',
  headTags: [
    { tagName: 'link', attributes: { rel: 'icon', type: 'image/png', sizes: '192x192', href: 'https://kesha-antonov.com/favicon-192.png' } },
    { tagName: 'link', attributes: { rel: 'apple-touch-icon', href: 'https://kesha-antonov.com/apple-touch-icon.png' } },
    { tagName: 'script', attributes: { type: 'application/ld+json' }, innerHTML: JSON.stringify(structuredData) },
  ],

  url: 'https://kesha-antonov.com',
  baseUrl: '/react-native-cloud-sync/',
  organizationName: 'kesha-antonov',
  projectName: 'react-native-cloud-sync',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  // A link to a heading that no longer exists lands the reader at the top of
  // the right page with no hint that anything is wrong. Defaults to 'warn',
  // which nobody reads in build output.
  onBrokenAnchors: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          // No editUrl: pages are generated from the repo root, so
          // scripts/sync-docs.mjs gives each one an "edit this page" link to
          // its source markdown rather than to the generated copy.
        },
        blog: false,
        sitemap: sitemapWithDates,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      // Preview image for links shared in chats and social networks.
      image: 'img/social-card.png',
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'react-native-cloud-sync',
        items: [
          { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
          { to: '/choosing-a-provider', label: 'Choosing a provider', position: 'left' },
          { to: '/comparison', label: 'Comparison', position: 'left' },
          { to: '/api', label: 'API', position: 'left' },
          {
            href: 'https://www.npmjs.com/package/react-native-cloud-sync',
            label: 'npm',
            position: 'right',
          },
          { href: REPO, label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Installation', to: '/installation' },
              { label: 'Choosing a provider', to: '/choosing-a-provider' },
              { label: 'Recipes', to: '/recipes' },
              { label: 'API', to: '/api' },
              { label: 'Platform Notes', to: '/platform-notes' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'GitHub', href: REPO },
              {
                label: 'npm',
                href: 'https://www.npmjs.com/package/react-native-cloud-sync',
              },
              { label: 'Issues', href: `${REPO}/issues` },
            ],
          },
          {
            title: 'More libraries',
            items: [
              { label: 'React Native Chat', href: 'https://kesha-antonov.com/react-native-chat/' },
              { label: 'React Native Zoom Reanimated', href: 'https://kesha-antonov.com/react-native-zoom-reanimated/' },
              { label: 'React Native Background Downloader', href: 'https://kesha-antonov.com/react-native-background-downloader/' },
              { label: 'React Native ActionCable', href: 'https://kesha-antonov.com/react-native-action-cable/' },
            ],
          },
          {
            title: 'Built by',
            items: [
              { label: 'Kesha Antonov', href: 'https://kesha-antonov.com' },
              { label: 'Hire a React Native lead engineer', href: 'https://kesha-antonov.com/react-native-developer' },
              { label: 'GitHub profile', href: 'https://github.com/kesha-antonov' },
              { label: 'Sponsor', href: 'https://github.com/sponsors/kesha-antonov' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Kesha Antonov. MIT licensed.`,
      },
      prism: {
        theme: themes.github,
        darkTheme: themes.dracula,
        additionalLanguages: ['bash', 'json', 'swift', 'objectivec', 'ruby'],
      },
    }),
}

module.exports = config
