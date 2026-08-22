import React from 'react'
import Link from '@docusaurus/Link'
import MDXComponents from '@theme-original/MDXComponents'

/**
 * Bare anchor target, e.g. the footnote markers under the comparison table.
 *
 * Written as `<a id="note-1"></a>` in README.md, because that is what GitHub
 * understands. MDX compiles a literal lowercase tag to an intrinsic element
 * rather than routing it through this component map, so Docusaurus never sees
 * the id and `onBrokenAnchors: 'throw'` fails the build on links that resolve
 * perfectly well in a browser. Going through `Link` registers the id.
 *
 * sync-docs.mjs rewrites those raw tags into this component.
 */
function Anchor ({ id }) {
  return <Link id={id} />
}

export default {
  ...MDXComponents,
  Anchor,
}
