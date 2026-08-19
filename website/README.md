# Documentation site

Docusaurus site published to GitHub Pages.

The pages under `docs/` are **generated** - do not edit them. They are produced
by `scripts/sync-docs.mjs` from the markdown at the repository root
(`README.md`, `docs/API.md`, `docs/PLATFORM_NOTES.md`), so the site can never
drift away from what a reader sees on GitHub or npm.

```sh
yarn install
yarn start     # sync + dev server
yarn build     # sync + production build
```

To change the page list or the sidebar, edit `PAGES` in `scripts/sync-docs.mjs`
and `sidebars.js` together.
