/**
 * URL policy for the intranet/local debugging browser.
 *
 * This is the ONE place the SSRF guard is deliberately relaxed: the standalone
 * intranet instance performs no private-IP screening (localhost, 10/8,
 * 192.168/16, link-local, ULA, … are all allowed) so local and LAN debugging
 * works. The ONLY safety net kept by default is the cloud-metadata blocklist
 * (169.254.169.254, `metadata.google.internal`, …), which stays on unless the
 * operator explicitly disables it. The original browser instance
 * (`browser-playwright`) is NOT affected — it keeps its strict url-guard.
 *
 * Every URL that passes this check is still routed through the plugin's
 * approval gate (see gate.ts) before any navigation happens.
 *
 * @module dsh-intranet-browser/url-check
 */

export class IntranetUrlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IntranetUrlError'
  }
}

/** Cloud-metadata hostnames blocked by default even though SSRF protection is bypassed. */
export const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
])

/** Cloud-metadata IP literals blocked by default. */
export const METADATA_IPS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure instance metadata
  'fd00:ec2::254', // AWS IMDSv2 IPv6
])

export interface IntranetUrlOptions {
  /** Allow `file://` URLs in addition to http(s). Defaults to `false`. */
  allowFile?: boolean
  /**
   * Keep blocking cloud-metadata endpoints even though SSRF protection is
   * bypassed. Defaults to `true`; flip to `false` only on networks you fully
   * control (e.g. a cloud VM where the metadata service is the point of the
   * test).
   */
  blockMetadata?: boolean
  /** Extra hostnames or IP literals that are always blocked. Defaults to none. */
  blockedHostnames?: ReadonlySet<string>
}

export interface IntranetUrlCheck {
  /**
   * Validate `raw` for the intranet browser: http(s) (optionally file) only,
   * no embedded credentials, and no metadata endpoint unless disabled.
   * @throws {IntranetUrlError} with a stable `code` when the URL is unusable.
   */
  assertUsableUrl(raw: string): URL
}

/** Build a permissive-but-not-naked URL check for the intranet browser. */
export function createIntranetUrlCheck(options: IntranetUrlOptions = {}): IntranetUrlCheck {
  const allowFile = options.allowFile ?? false
  const blockMetadata = options.blockMetadata ?? true
  const extra = options.blockedHostnames ?? new Set<string>()

  function parse(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new IntranetUrlError('WEB_INVALID_URL', `Invalid URL: ${raw}`)
    }
    const schemeOk = url.protocol === 'http:' || url.protocol === 'https:' || (allowFile && url.protocol === 'file:')
    if (!schemeOk) {
      throw new IntranetUrlError(
        'WEB_INVALID_URL',
        `Only http(s)${allowFile ? ' and file' : ''} URLs are allowed: ${raw}`,
      )
    }
    if (url.username || url.password) {
      throw new IntranetUrlError('WEB_BLOCKED_URL', 'URLs with embedded credentials are blocked')
    }
    return url
  }

  function hostOf(url: URL): string {
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  }

  function assertAllowed(url: URL): void {
    const host = hostOf(url)
    if (extra.has(host)) {
      throw new IntranetUrlError('WEB_BLOCKED_URL', `Hostname is blocked by intranet-browser config: ${host}`)
    }
    if (blockMetadata && (METADATA_HOSTNAMES.has(host) || METADATA_IPS.has(host))) {
      throw new IntranetUrlError('WEB_BLOCKED_URL', `Cloud metadata endpoint is blocked: ${host}`)
    }
  }

  return {
    assertUsableUrl(raw: string): URL {
      const url = parse(raw)
      assertAllowed(url)
      return url
    },
  }
}
