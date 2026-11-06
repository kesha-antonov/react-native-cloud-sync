import { Plus, Check, Cloud, Globe, Smartphone, Tablet, Laptop } from 'lucide-react'
import { Stage, Phone, Window, Bar, BrandMark, Connector, States, type Act, type Rect } from './kit'
import './cloud-sync.css'

// react-native-cloud-sync, as a system story. One book app on every screen:
// the web and an Android phone on Google Drive, an iPad and a Mac on iCloud,
// and the iPhone in the middle on both. A tap on the iPhone saves the book:
// the change travels up to both clouds, then down to every other screen.
// Android un-saves it and the change comes back through Drive to the iPhone,
// which passes it on to iCloud. That is also the loop's reset: every change
// on screen has a tap behind it.
//
// Android and the web never touch iCloud, and the iPad and Mac never touch
// Drive. Real strings: Shelf, Dune, Want to read / Saved, iCloud,
// Google Drive, shelf.app.

// Each arrow is named for its two ends: i iPhone, a Android, w web,
// p iPad, m Mac, d Drive, c iCloud
type Arrow = 'i-d' | 'd-i' | 'i-c' | 'd-a' | 'a-d' | 'd-w' | 'c-m' | 'c-p'
type S = { ios: boolean; android: boolean; web: boolean; ipad: boolean; mac: boolean; on: Arrow[] }

const START: S = { ios: false, android: false, web: false, ipad: false, mac: false, on: [] }
const POSTER: S = { ios: true, android: true, web: true, ipad: true, mac: true, on: ['i-d', 'i-c', 'd-a', 'd-w', 'c-m', 'c-p'] }

const script = async (a: Act<S>) => {
  await a.wait(1000)
  a.mark('save')
  await a.click('ios-btn')
  a.put({ ios: true })
  await a.wait(250)
  a.put({ on: ['i-d', 'i-c'] })
  await a.wait(1000)
  a.put({ on: ['i-d', 'i-c', 'd-a', 'd-w', 'c-m', 'c-p'] })
  await a.wait(950)
  a.put({ android: true })
  await a.wait(120)
  a.put({ mac: true })
  await a.wait(120)
  a.put({ web: true })
  await a.wait(120)
  a.put({ ipad: true })
  a.mark('synced')
  await a.wait(2000)
  a.put({ on: [] })
  await a.wait(700)
  a.mark('unsave')
  await a.click('android-btn')
  a.put({ android: false })
  await a.wait(250)
  a.put({ on: ['a-d'] })
  await a.wait(1000)
  a.put({ on: ['a-d', 'd-i', 'd-w'] })
  await a.wait(950)
  a.put({ ios: false })
  await a.wait(120)
  a.put({ web: false })
  // The iPhone passes the change on to iCloud. The compact layout has no
  // iCloud side, so it skips the relay rather than hold on nothing
  if (a.layout === 'wide') {
    await a.wait(400)
    a.mark('relay')
    a.put({ on: ['i-c'] })
    await a.wait(1000)
    a.put({ on: ['i-c', 'c-m', 'c-p'] })
    await a.wait(950)
  }
  a.put({ mac: false })
  await a.wait(120)
  a.put({ ipad: false })
  await a.wait(1600)
  a.put({ on: [] })
  await a.move(a.layout === 'wide' ? { x: 560, y: 450 } : { x: 280, y: 420 })
  await a.wait(400)
}

function SaveButton({ on, target, size = 'phone' }: { on: boolean; target?: string; size?: 'phone' | 'web' }) {
  const icon = size === 'phone' ? 30 : 12
  return (
    <span className={`sd-btn sd-btn--${size}`} data-on={on || undefined} data-target={target}>
      <States
        value={on ? 'on' : 'off'}
        states={{
          off: (
            <span className="sd-btn__label">
              <Plus size={icon} strokeWidth={2.5} /> Want to read
            </span>
          ),
          on: (
            <span className="sd-btn__label">
              <Check size={icon} strokeWidth={2.5} /> Saved
            </span>
          ),
        }}
      />
    </span>
  )
}

/** The phone and tablet app, laid out in points */
function Screen({ on, target, kind }: { on: boolean; target?: string; kind: 'ios' | 'android' | 'ipad' }) {
  return (
    <div className={`sd-app sd-app--${kind}`}>
      <div className="sd-app__title">Shelf</div>
      <div className="sd-cover" />
      <div className="sd-book">Dune</div>
      <div className="sd-author">Frank Herbert</div>
      <SaveButton on={on} target={target} />
      <div className="sd-more">
        <Bar w={150} h={12} r={6} tone={3} />
        <div className="sd-shelf">
          <span className="sd-mini sd-mini--a" />
          <span className="sd-mini sd-mini--b" />
          <span className="sd-mini sd-mini--c" />
        </div>
      </div>
    </div>
  )
}

/** The browser and the Mac show the same desktop page */
function Desk({ on }: { on: boolean }) {
  return (
    <div className="sd-web__body">
      <div className="sd-cover sd-cover--web" />
      <div className="sd-web__text">
        <div className="sd-book sd-book--web">Dune</div>
        <div className="sd-author sd-author--web">Frank Herbert</div>
      </div>
      <SaveButton on={on} size="web" />
      <div className="sd-web__lines">
        <Bar w={84} h={7} r={3} tone={3} />
        <div className="sd-shelf sd-shelf--web">
          <span className="sd-mini sd-mini--a" />
          <span className="sd-mini sd-mini--b" />
          <span className="sd-mini sd-mini--c" />
        </div>
        <Bar w={60} h={7} r={3} tone={3} />
        <div className="sd-shelf sd-shelf--web">
          <span className="sd-mini sd-mini--c" />
          <span className="sd-mini sd-mini--a" />
          <span className="sd-mini sd-mini--b" />
        </div>
      </div>
    </div>
  )
}

function IPad({ on, ...rest }: { on: boolean } & Record<string, unknown>) {
  return (
    <div className="sd-ipad" {...rest}>
      <div className="sd-ipad__screen">
        <Screen on={on} kind="ipad" />
      </div>
    </div>
  )
}

function MacBook({ on, ...rest }: { on: boolean } & Record<string, unknown>) {
  return (
    <div className="sd-mac" {...rest}>
      <div className="sd-mac__lid">
        <div className="sd-mac__screen">
          <div className="sd-mac__menu">
            <span className="sd-mac__apple" />
            <b>Shelf</b>
          </div>
          <Desk on={on} />
        </div>
      </div>
      <div className="sd-mac__base" />
    </div>
  )
}

/** A device's name, lit while a change goes in or out of it */
function Label({ at, active, icon: Icon, children }: { at: P; active: boolean; icon: typeof Globe; children: string }) {
  return (
    <span className="sd-label" style={{ left: at.x, top: at.y }} data-active={active || undefined}>
      <Icon size={12} strokeWidth={2.2} /> {children}
    </span>
  )
}

type P = { x: number; y: number }
const mid = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
const left = (r: Rect, y?: number) => ({ x: r.x, y: y ?? r.y + r.height / 2 })
const right = (r: Rect, y?: number) => ({ x: r.x + r.width, y: y ?? r.y + r.height / 2 })
const top = (r: Rect, x: number) => ({ x, y: r.y })
const bottom = (r: Rect, x: number) => ({ x, y: r.y + r.height })
// An arrow stops a little short of what it points at
const short = (p: P, from: P, by = 6) => {
  const d = Math.hypot(p.x - from.x, p.y - from.y) || 1
  return { x: p.x - ((p.x - from.x) / d) * by, y: p.y - ((p.y - from.y) / d) * by }
}
// Elbows: the arrow sits on the last leg, so stop short along it
const lastAcross = (to: P, from: P) => short(to, { x: from.x, y: to.y })
const lastDown = (to: P, from: P) => short(to, { x: to.x, y: from.y })

/** `driveSrc` overrides the bundled Drive artwork, for hosts whose bundler
 * does not serve the kit's `new URL(...)` assets. */
export default function CloudSync({ dark, driveSrc }: { dark?: boolean; driveSrc?: string }) {
  return (
    <Stage<S>
      width={760}
      height={460}
      compact={{ below: 600, width: 358, height: 380 }}
      initial={START}
      poster={POSTER}
      script={script}
      cursor={{ at: { wide: { x: 560, y: 450 }, compact: { x: 280, y: 420 } }, style: 'touch' }}
      theme={dark ? 'dark' : 'light'}
      className="sd"
    >
      {(s, rect, layout) => {
        const wide = layout === 'wide'
        const has = (k: Arrow) => s.on.includes(k)
        const ios = rect('ios')
        const android = rect('android')
        const drive = rect('drive')
        const icloud = rect('icloud')
        const web = rect('web')
        const ipad = rect('ipad')
        const mac = rect('mac')
        const ready = ios && android && drive
        const driveOn = has('i-d') || has('d-i') || has('a-d')
        const icloudOn = has('i-c')
        return (
          <>
            {wide && (
              <Window chrome="hairline" url="shelf.app" className="sd-web" data-target="web">
                <Desk on={s.web} />
              </Window>
            )}
            {wide && <MacBook on={s.mac} data-target="mac" />}

            <Phone width={wide ? 140 : 158} frame="android" dark={dark} className="sd-phone sd-phone--android" data-target="android">
              <Screen on={s.android} target="android-btn" kind="android" />
            </Phone>
            <Phone width={wide ? 140 : 158} frame="pro" dark={dark} className="sd-phone sd-phone--ios" data-target="ios">
              <Screen on={s.ios} target="ios-btn" kind="ios" />
            </Phone>

            {wide && <IPad on={s.ipad} data-target="ipad" />}

            {wide && (
              <span className="sd-chip sd-chip--icloud" data-target="icloud" data-active={icloudOn || undefined}>
                <Cloud size={16} strokeWidth={2.2} fill="currentColor" /> iCloud
              </span>
            )}
            <span className="sd-chip sd-chip--drive" data-target="drive" data-active={driveOn || undefined}>
              {driveSrc ? <BrandMark name="Google Drive" src={driveSrc} size={18} tile={false} /> : <BrandMark brand="google-drive" size={18} tile={false} />} {wide && 'Google Drive'}
            </span>

            {ready && wide && web && ipad && mac && (
              <>
                <Label at={{ x: mid(web).x, y: 420 }} active={has('d-w')} icon={Globe}>Web</Label>
                <Label at={{ x: mid(android).x, y: 420 }} active={has('d-a') || has('a-d')} icon={Smartphone}>Android</Label>
                <Label at={{ x: mid(ios).x, y: 420 }} active={has('i-d') || has('d-i') || has('i-c')} icon={Smartphone}>iPhone</Label>
                {/* Under the Mac, in the room the iPad leaves */}
                <Label at={{ x: (ios.x + ios.width + ipad.x) / 2, y: mac.y + mac.height + 14 }} active={has('c-m')} icon={Laptop}>Mac</Label>
                <Label at={{ x: mid(ipad).x, y: 420 }} active={has('c-p')} icon={Tablet}>iPad</Label>
              </>
            )}
            {ready && !wide && (
              <>
                <Label at={{ x: mid(android).x, y: 340 }} active={has('d-a') || has('a-d')} icon={Smartphone}>Android</Label>
                <Label at={{ x: mid(ios).x, y: 340 }} active={has('i-d') || has('d-i')} icon={Smartphone}>iPhone</Label>
              </>
            )}

            {ready && wide && icloud && web && ipad && mac && (() => {
              // Two stems leave the iPhone's top: one to each cloud
              const iD = top(ios, ios.x + ios.width * 0.34)
              const iC = top(ios, ios.x + ios.width * 0.66)
              const dR = right(drive)
              const cL = left(icloud)
              // Drive drops to the web and to Android, iCloud to the Mac and,
              // around the Mac's side, to the iPad
              const dW = bottom(drive, drive.x + 22)
              const wT = top(web, dW.x)
              const dA = bottom(drive, drive.x + drive.width - 22)
              const aT = top(android, dA.x)
              const cM = bottom(icloud, mid(icloud).x - 12)
              const mT = top(mac, cM.x)
              const cR = right(icloud)
              const pT = top(ipad, mac.x + mac.width + (ipad.x + ipad.width - mac.x - mac.width) / 2)
              return (
                <>
                  {/* The wiring, always there and quiet */}
                  <Connector className="sd-wire" show dots="none" route="v" from={iD} to={dR} />
                  <Connector className="sd-wire" show dots="none" route="v" from={iC} to={cL} />
                  <Connector className="sd-wire" show dots="none" route="straight" from={dW} to={wT} />
                  <Connector className="sd-wire" show dots="none" route="straight" from={dA} to={aT} />
                  <Connector className="sd-wire" show dots="none" route="straight" from={cM} to={mT} />
                  <Connector className="sd-wire" show dots="none" route="h" from={cR} to={pT} />

                  <Connector arrow show={has('i-d')} route="v" from={iD} to={lastAcross(dR, iD)} />
                  <Connector arrow show={has('d-i')} route="h" from={dR} to={lastDown(iD, dR)} />
                  <Connector arrow show={has('i-c')} route="v" from={iC} to={lastAcross(cL, iC)} />
                  <Connector arrow show={has('d-w')} route="straight" from={dW} to={short(wT, dW)} />
                  <Connector arrow show={has('d-a')} route="straight" from={dA} to={short(aT, dA)} />
                  <Connector arrow show={has('a-d')} route="straight" from={aT} to={short(dA, aT)} />
                  <Connector arrow show={has('c-m')} route="straight" from={cM} to={short(mT, cM)} />
                  <Connector arrow show={has('c-p')} route="h" from={cR} to={lastDown(pT, cR)} />
                </>
              )
            })()}

            {ready && !wide && (() => {
              const aTop = { x: mid(android).x, y: android.y }
              const iTop = { x: mid(ios).x, y: ios.y }
              const dl = left(drive)
              const dr = right(drive)
              return (
                <>
                  <Connector className="sd-wire" show dots="none" route="v" from={aTop} to={dl} />
                  <Connector className="sd-wire" show dots="none" route="v" from={iTop} to={dr} />
                  <Connector arrow show={has('i-d')} route="v" from={iTop} to={lastAcross(dr, iTop)} />
                  <Connector arrow show={has('d-a')} route="h" from={dl} to={lastDown(aTop, dl)} />
                  <Connector arrow show={has('a-d')} route="v" from={aTop} to={lastAcross(dl, aTop)} />
                  <Connector arrow show={has('d-i')} route="h" from={dr} to={lastDown(iTop, dr)} />
                </>
              )
            })()}
          </>
        )
      }}
    </Stage>
  )
}
