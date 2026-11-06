# Documentation site

Docusaurus site, published to GitHub Pages.

Pages under `docs/` are **generated**; do not edit them. `scripts/sync-docs.mjs`
builds them from the repository root markdown (`README.md`, `docs/*.md`), so the
site always matches GitHub and npm.

```sh
yarn install
yarn start     # sync + dev server
yarn build     # sync + production build
```

To change pages or the sidebar, edit `PAGES` in `scripts/sync-docs.mjs` and
`sidebars.js` together.
