import React from 'react'
import BrowserOnly from '@docusaurus/BrowserOnly'
import { useColorMode } from '@docusaurus/theme-common'
import useBaseUrl from '@docusaurus/useBaseUrl'
import styles from './styles.module.css'

// The animated "how sync works" scene at the top of the intro page. It
// measures the page as it plays, so it renders in the browser only; the
// placeholder keeps the same aspect ratio so nothing below it jumps.
function Live () {
  const { colorMode } = useColorMode()
  const driveSrc = useBaseUrl('/img/google-drive.svg')
  const Scene = require('./Scene').default
  return <Scene dark={colorMode === 'dark'} driveSrc={driveSrc} />
}

export default function SyncDemo () {
  return (
    <figure className={styles.figure}>
      <BrowserOnly fallback={<div className={styles.placeholder} />}>
        {() => <Live />}
      </BrowserOnly>
      <figcaption className={styles.caption}>
        Same data on iPhone, iPad, Mac, Android and the web, synced both ways.
      </figcaption>
    </figure>
  )
}
