// @ts-check
const { themes } = require('prism-react-renderer')

const REPO = 'https://github.com/kesha-antonov/react-native-cloud-storage'

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'React Native Cloud Storage',
  tagline: 'iCloud, CloudKit and Google Drive behind one API - iOS, Android and web',
  favicon: 'img/favicon.svg',

  url: 'https://kesha-antonov.github.io',
  baseUrl: '/react-native-cloud-storage/',
  organizationName: 'kesha-antonov',
  projectName: 'react-native-cloud-storage',
  trailingSlash: false,

  onBrokenLinks: 'throw',
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
          // Pages are generated from the repo root, so "edit this page" must
          // point at the source markdown rather than the generated copy.
          editUrl: `${REPO}/edit/main/`,
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'react-native-cloud-storage',
        items: [
          { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
          { to: '/comparison', label: 'Comparison', position: 'left' },
          { to: '/api', label: 'API', position: 'left' },
          {
            href: 'https://www.npmjs.com/package/@kesha-antonov/react-native-cloud-storage',
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
              { label: 'Usage', to: '/usage' },
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
                href: 'https://www.npmjs.com/package/@kesha-antonov/react-native-cloud-storage',
              },
              { label: 'Issues', href: `${REPO}/issues` },
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
