import { CloudStorageError, ErrorCode } from '../errors'

/**
 * Google Drive `appDataFolder` REST client.
 *
 * `appDataFolder` is a hidden per-app, per-Google-account folder: nothing shows
 * up in the user's visible Drive, and the data survives an app uninstall because
 * it is tied to the account rather than the install.
 *
 * Auth is deliberately injected rather than owned. The library does not depend
 * on `@react-native-google-signin/google-signin` (or any other sign-in library),
 * so the host app keeps control of the consent flow, and the same client works
 * unchanged in a browser where that library does not apply.
 */

export interface GoogleDriveConfig {
  /**
   * Returns a valid OAuth access token with the `drive.appdata` scope, or null
   * if the user is not connected. Called before every request, so implementers
   * should refresh silently here rather than caching a stale token.
   */
  getAccessToken: () => Promise<string | null> | string | null
  /** Called when Drive rejects the token, so the host can prompt for reconnect. */
  onAuthExpired?: () => Promise<void> | void
  fetchImpl?: typeof fetch
}

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

interface DriveFile {
  id: string
  name: string
}

export class GoogleDriveClient {
  private readonly config: GoogleDriveConfig
  /**
   * name -> fileId.
   *
   * Drive has no "get by name" endpoint, so every read would otherwise cost a
   * list query. react-native-cloud-storage's Drive backend does exactly that and
   * additionally lists the *whole* drive before filtering client-side, which its
   * users measured in minutes (kuatsu#49) and which can loop forever (kuatsu#39).
   * A scoped `q=` query plus this cache keeps a read to one request, usually zero.
   */
  private readonly idCache = new Map<string, string>()

  constructor(config: GoogleDriveConfig) {
    this.config = config
  }

  private get fetch(): typeof fetch {
    return this.config.fetchImpl ?? globalThis.fetch
  }

  private async requireToken(): Promise<string> {
    const token = await this.config.getAccessToken()
    if (!token)
      throw new CloudStorageError(
        ErrorCode.NOT_SIGNED_IN,
        '[RNCloudStorage] No Google Drive access token. Connect a Google account first.',
        { provider: 'googleDrive' }
      )

    return token
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const token = await this.requireToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)

    let res: Response
    try {
      res = await this.fetch(url, { ...init, headers })
    }
    catch (e) {
      throw new CloudStorageError(
        ErrorCode.NETWORK_UNAVAILABLE,
        '[RNCloudStorage] Google Drive request failed to reach the server.',
        { provider: 'googleDrive', cause: e }
      )
    }

    if (res.ok) return res

    if (res.status === 401 || res.status === 403) {
      await this.config.onAuthExpired?.()
      throw new CloudStorageError(
        ErrorCode.AUTH_EXPIRED,
        `[RNCloudStorage] Google Drive returned HTTP ${res.status}; the access token is not valid.`,
        { provider: 'googleDrive' }
      )
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After'))
      throw new CloudStorageError(
        ErrorCode.RATE_LIMITED,
        '[RNCloudStorage] Google Drive rate limited the request.',
        {
          provider: 'googleDrive',
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        }
      )
    }
    if (res.status === 507)
      throw new CloudStorageError(
        ErrorCode.QUOTA_EXCEEDED,
        '[RNCloudStorage] Google Drive storage quota exceeded.',
        { provider: 'googleDrive' }
      )

    throw new CloudStorageError(
      ErrorCode.UNKNOWN,
      `[RNCloudStorage] Google Drive returned HTTP ${res.status}.`,
      { provider: 'googleDrive' }
    )
  }

  /** Resolves a file name to its id within appDataFolder, or null if absent. */
  private async findFileId(name: string): Promise<string | null> {
    const cached = this.idCache.get(name)
    if (cached != null) return cached

    // Scope the query server-side. Escaping matters: an apostrophe in a key
    // would otherwise terminate the quoted literal and produce a malformed query.
    const q = encodeURIComponent(`name='${name.replace(/'/g, '\\\'')}' and trashed=false`)
    const url = `${FILES_URL}?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=10`

    const res = await this.request(url, { method: 'GET' })
    const json = (await res.json()) as { files?: DriveFile[] }
    const file = json.files?.find(f => f.name === name)
    if (file == null) return null

    this.idCache.set(name, file.id)
    return file.id
  }

  async getItem(name: string): Promise<string | null> {
    const id = await this.findFileId(name)
    if (id == null) return null

    const res = await this.request(`${FILES_URL}/${id}?alt=media`, { method: 'GET' })
    return await res.text()
  }

  async setItem(name: string, value: string): Promise<void> {
    const id = await this.findFileId(name)

    if (id != null) {
      await this.request(`${UPLOAD_URL}/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: value,
      })
      return
    }

    // Multipart create: metadata part pins the file into appDataFolder, second
    // part carries the content.
    const boundary = `rncs-${Math.random().toString(36).slice(2)}`
    const metadata = JSON.stringify({ name, parents: ['appDataFolder'] })
    const body
      = `--${boundary}\r\n`
        + `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
        + `--${boundary}\r\n`
        + `Content-Type: application/json\r\n\r\n${value}\r\n`
        + `--${boundary}--`

    const res = await this.request(`${UPLOAD_URL}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    const json = (await res.json()) as { id?: string }
    if (json.id != null) this.idCache.set(name, json.id)
  }

  async removeItem(name: string): Promise<void> {
    const id = await this.findFileId(name)
    // Already absent is the desired end state, not a failure.
    if (id == null) return

    await this.request(`${FILES_URL}/${id}`, { method: 'DELETE' })
    this.idCache.delete(name)
  }

  async getAllKeys(): Promise<string[]> {
    const names: string[] = []
    let pageToken: string | undefined

    // Paginate rather than assuming one page holds everything.
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: 'trashed=false',
        fields: 'nextPageToken,files(id,name)',
        pageSize: '100',
      })
      if (pageToken != null) params.set('pageToken', pageToken)

      const res = await this.request(`${FILES_URL}?${params.toString()}`, { method: 'GET' })
      const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string }

      for (const f of json.files ?? []) {
        names.push(f.name)
        this.idCache.set(f.name, f.id)
      }
      pageToken = json.nextPageToken
    } while (pageToken != null)

    return names
  }

  /**
   * Whether an access token can currently be obtained, without making a network
   * request. Backs the provider's `isAvailable()` probe.
   */
  async hasToken(): Promise<boolean> {
    try {
      return (await this.config.getAccessToken()) != null
    }
    catch {
      return false
    }
  }

  /** Drops memoised file ids. Call after an account switch. */
  clearCache(): void {
    this.idCache.clear()
  }
}
