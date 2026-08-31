/** Unit tests for the permissive-but-not-naked intranet URL policy. @module dsh-intranet-browser/test */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createIntranetUrlCheck,
  IntranetUrlError,
  METADATA_HOSTNAMES,
  METADATA_IPS,
} from '../src/url-check.js'

const check = (overrides: Parameters<typeof createIntranetUrlCheck>[0] = {}) =>
  createIntranetUrlCheck(overrides)

describe('intranet url-check — the deliberate SSRF-guard bypass', () => {
  it('allows localhost and loopback', () => {
    for (const url of ['http://localhost:8080/', 'http://127.0.0.1:3000/', 'http://[::1]:5173/']) {
      assert.equal(check().assertUsableUrl(url).toString(), new URL(url).toString(), url)
    }
  })

  it('allows private LAN ranges and link-local / ULA IPv6', () => {
    for (const url of [
      'http://10.0.0.5/', // 10/8
      'http://172.16.4.4:9000/', // 172.16/12
      'http://192.168.1.10/', // 192.168/16
      'http://169.254.10.10/', // link-local (NOT the metadata IP)
      'http://[fc00::1]/', // ULA
      'http://[fe80::1]/', // link-local v6
    ]) {
      assert.equal(check().assertUsableUrl(url).toString(), new URL(url).toString(), url)
    }
  })

  it('allows fake-ip / proxy pools (198.18/15) and public hosts', () => {
    for (const url of ['http://198.18.2.3/', 'https://example.com/']) {
      assert.equal(check().assertUsableUrl(url).toString(), new URL(url).toString(), url)
    }
  })

  it('rejects non-http(s) schemes', () => {
    for (const url of ['mailto:a@b.c', 'javascript:alert(1)', 'ftp://host/', 'file:///C:/x.html']) {
      assert.throws(() => check().assertUsableUrl(url), (e: unknown) => {
        assert.ok(e instanceof IntranetUrlError)
        assert.equal((e as IntranetUrlError).code, 'WEB_INVALID_URL')
        return true
      })
    }
  })

  it('rejects invalid URLs', () => {
    assert.throws(() => check().assertUsableUrl('not a url'), IntranetUrlError)
  })

  it('rejects URLs with embedded credentials', () => {
    assert.throws(
      () => check().assertUsableUrl('http://user:pass@localhost/'),
      (e: unknown) => (e as IntranetUrlError).code === 'WEB_BLOCKED_URL',
    )
  })

  it('blocks cloud metadata hostnames and IPs by default', () => {
    for (const host of [...METADATA_HOSTNAMES]) {
      assert.throws(
        () => check().assertUsableUrl(`http://${host}/`),
        (e: unknown) => (e as IntranetUrlError).code === 'WEB_BLOCKED_URL',
        host,
      )
    }
    for (const ip of [...METADATA_IPS]) {
      assert.throws(
        () => check().assertUsableUrl(`http://${ip.includes(':') ? `[${ip}]` : ip}/`),
        (e: unknown) => (e as IntranetUrlError).code === 'WEB_BLOCKED_URL',
        ip,
      )
    }
  })

  it('can be configured to allow metadata endpoints (explicit operator opt-out)', () => {
    assert.doesNotThrow(() => check({ blockMetadata: false }).assertUsableUrl('http://169.254.169.254/latest/meta-data/'))
    assert.doesNotThrow(() => check({ blockMetadata: false }).assertUsableUrl('http://metadata.google.internal/'))
  })

  it('honors extra blocked hostnames', () => {
    const c = check({ blockedHostnames: new Set(['router.home', '10.9.9.9']) })
    assert.throws(() => c.assertUsableUrl('http://router.home/'), IntranetUrlError)
    assert.throws(() => c.assertUsableUrl('http://10.9.9.9/'), IntranetUrlError)
    assert.doesNotThrow(() => c.assertUsableUrl('http://10.0.0.1/'))
  })

  it('file URLs are rejected unless allowFile is enabled', () => {
    assert.throws(() => check().assertUsableUrl('file:///C:/temp/index.html'), IntranetUrlError)
    assert.equal(
      check({ allowFile: true }).assertUsableUrl('file:///C:/temp/index.html').protocol,
      'file:',
    )
  })
})
