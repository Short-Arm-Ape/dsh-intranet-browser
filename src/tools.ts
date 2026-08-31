/**
 * Model-facing `intranet_*` tools for the standalone intranet/local debugging
 * browser.
 *
 * These tools deliberately operate on a SEPARATE browser instance that skips
 * the SSRF guard, so localhost / LAN / internal hosts are reachable. Every call
 * is gated behind user approval (see gate.ts) — the model should expect an
 * approval prompt and should not spam these tools.
 *
 * @module dsh-intranet-browser/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BrowserPage, BrowserPageOptions } from '@yeesy369/dsh-browser'
import type { Config } from './config.js'
import type { IntranetBrowserRuntime } from './runtime.js'

/** Pull a stable session key from the tool execution context. */
export function sessionKeyOf(exec: { session?: unknown; agent?: unknown }): string {
  const session = exec.session
  if (typeof session === 'object' && session !== null && 'id' in session) {
    const id = (session as { id: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  const agent = exec.agent
  if (typeof agent === 'object' && agent !== null && 'id' in agent) {
    const id = (agent as { id: unknown }).id
    if (typeof id === 'string' && id) return `agent:${id}`
  }
  return 'default'
}

function pageOptions(exec: { session?: unknown; agent?: unknown }): BrowserPageOptions {
  return { sessionKey: sessionKeyOf(exec) }
}

export interface ScreenshotToolValue {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  attachment?: ImageAttachmentRef
}

/** Model-visible screenshot output: caption plus a durable image block. */
export function screenshotBlocks(value: ScreenshotToolValue): Array<
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
> {
  const attachment = value.attachment ?? {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
  } as ImageAttachmentRef
  return [
    {
      type: 'text',
      text: `Screenshot captured (${value.width}×${value.height}, ${value.bytes} bytes, ${value.mediaType}, attachment ${value.attachmentId}).`,
    },
    { type: 'image', attachment },
  ]
}

const NOTE = 'Operates in the intranet/local debugging browser: a SEPARATE browser window whose SSRF guard is bypassed (localhost, LAN and private IPs allowed). EVERY call requires user approval.'

const actionOutput = {
  schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string' as const, required: true as const },
      ok: { type: 'boolean' as const, required: true as const },
    },
    additionalProperties: false,
  },
}

const navigateOutput = {
  schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string' as const, required: true as const },
      title: { type: 'string' as const, required: true as const },
      status: { type: 'number' as const, description: 'HTTP status code of the navigation, when available.' },
    },
    additionalProperties: false,
  },
}

export interface ToolsDeps {
  getConfig(): Config
  browser: IntranetBrowserRuntime
}

/** Register the `intranet_*` tool set on `ctx.tools`. */
export function registerIntranetTools(ctx: Context, deps: ToolsDeps): void {
  const { tools, attachments } = ctx
  const { getConfig, browser } = deps

  const currentPage = async (exec: { signal?: AbortSignal; session?: unknown; agent?: unknown }): Promise<BrowserPage> =>
    browser.newPage(pageOptions(exec), exec.signal)

  tools.register(defineTool({
    name: 'intranet_open',
    description: `Open an HTTP(S) (optionally file) URL in the intranet/local debugging browser and report the resulting page title. ${NOTE}`,
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to open. localhost, LAN and private addresses are allowed.' },
    },
    output: {
      ...navigateOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `Opened ${value.url}${typeof value.status === 'number' ? ` (HTTP ${value.status})` : ''}${value.title ? ` — ${value.title}` : ''}`,
      }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.navigate(args.url, exec.signal)
      return { url: result.url, title: result.title ?? '', status: result.statusCode ?? undefined }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_snapshot',
    description: `Return a compact accessibility snapshot of the current intranet browser page. ${NOTE}`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', required: true },
          text: { type: 'string', required: true },
          refs: { type: 'array', items: { type: 'string' }, required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const snap = await page.snapshot(exec.signal)
      return { url: snap.url, text: snap.text, refs: [...snap.refs] }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_screenshot',
    description: `Capture a screenshot of the current intranet browser page as a durable image attachment. ${NOTE}`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => screenshotBlocks(value),
    },
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const shot = await page.screenshot(exec.signal)
      const ref: ImageAttachmentRef = await attachments.saveImage({
        data: shot.data,
        mediaType: shot.mediaType,
        name: `intranet-${Date.now()}.png`,
      })
      const r = ref as ImageAttachmentRef & { id?: string; size?: number }
      return {
        attachmentId: r.attachmentId ?? r.id ?? '',
        mediaType: r.mediaType ?? shot.mediaType,
        bytes: r.bytes ?? r.size ?? shot.data.byteLength,
        width: r.width ?? shot.width,
        height: r.height ?? shot.height,
      }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_click',
    description: `Click an element in the current intranet browser page by accessibility ref (from intranet_snapshot) or CSS selector. ${NOTE}`,
    parameters: {
      ref: { type: 'string', required: true, description: 'An accessibility ref (e.g. e1 from intranet_snapshot) or CSS selector.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Clicked (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.click(args.ref, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_type',
    description: `Type text into the currently focused element of the intranet browser page. ${NOTE}`,
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Typed (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.type(args.text, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_fill',
    description: `Replace the value of an input or textarea identified by accessibility ref (from intranet_snapshot) or CSS selector. ${NOTE}`,
    parameters: {
      ref: { type: 'string', required: true, description: 'An accessibility ref or CSS selector.' },
      value: { type: 'string', required: true, description: 'The value to fill.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Filled (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.fill(args.ref, args.value, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_press',
    description: `Press a key (Enter, Tab, Escape, ArrowDown, …) in the intranet browser page, optionally on an element identified by ref or CSS selector. ${NOTE}`,
    parameters: {
      key: { type: 'string', required: true, description: 'Playwright key name, e.g. Enter, Tab, Control+a.' },
      ref: { type: 'string', description: 'Optional accessibility ref or CSS selector.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Pressed (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.press(args.key, args.ref, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_scroll',
    description: `Scroll the intranet browser page by a pixel amount in a direction (default: 800px down). Use intranet_snapshot or intranet_screenshot to see the new viewport. ${NOTE}`,
    parameters: {
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Direction to scroll. Defaults to down.',
      },
      amount: {
        type: 'number',
        description: 'Distance in CSS pixels. Defaults to 800.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', required: true },
          scrollX: { type: 'number', required: true },
          scrollY: { type: 'number', required: true },
          atBoundary: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Scrolled to (${value.scrollX}, ${value.scrollY}) at ${value.url}${value.atBoundary ? ' — reached the edge of the page' : ''}`,
      }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const result = await page.scroll({ direction: args.direction, amount: args.amount }, exec.signal)
      return { url: result.url, scrollX: result.scrollX, scrollY: result.scrollY, atBoundary: result.atBoundary }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_wait',
    description: `Wait a bounded duration for lazy content in the intranet browser page. ${NOTE}`,
    parameters: {
      ms: { type: 'number', description: `Milliseconds to wait (capped at ${getConfig().maxWaitMs}). Defaults to 1000.` },
      load: { type: 'boolean', description: 'If true, also wait for domcontentloaded after the timer.' },
    },
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Waited (ok=${value.ok}) at ${value.url}` }],
    },
    timeoutMs: Math.max(getConfig().maxWaitMs, 60_000) + 5_000,
    async execute(args, exec) {
      const page = await currentPage(exec)
      const ms = Math.max(0, Math.min(args.ms ?? 1000, getConfig().maxWaitMs))
      const result = await page.wait({ ms, load: args.load }, exec.signal)
      return { url: result.url, ok: result.ok }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_back',
    description: `Navigate the intranet browser page back in history. ${NOTE}`,
    parameters: {},
    output: {
      ...navigateOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `Went back to ${value.url}${value.title ? ` — ${value.title}` : ''}`,
      }],
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const result = await page.back(exec.signal)
      return { url: result.url, title: result.title ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_forward',
    description: `Navigate the intranet browser page forward in history. ${NOTE}`,
    parameters: {},
    output: {
      ...navigateOutput,
      render: (_args, value) => [{
        type: 'text',
        text: `Went forward to ${value.url}${value.title ? ` — ${value.title}` : ''}`,
      }],
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const page = await currentPage(exec)
      const result = await page.forward(exec.signal)
      return { url: result.url, title: result.title ?? '' }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_close',
    description: `Close the intranet browser window and release its profile lock. ${NOTE}`,
    parameters: {},
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Closed intranet browser (ok=${value.ok})` }],
    },
    async execute(_args, exec) {
      await browser.close(exec.signal)
      return { url: '', ok: true }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_arm',
    description: 'Arm the intranet/local debugging browser for the current session: after approval, subsequent intranet_* calls run without per-call prompts (only honored when approvalMode is "arm"). Requires user approval.',
    parameters: {},
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Intranet browser armed (ok=${value.ok}) at ${value.url}` }],
    },
    async execute(_args, exec) {
      void exec
      return { url: '', ok: true }
    },
  }))

  tools.register(defineTool({
    name: 'intranet_disarm',
    description: 'Disarm the intranet/local debugging browser for the current session: per-call approval prompts resume.',
    parameters: {},
    output: {
      ...actionOutput,
      render: (_args, value) => [{ type: 'text', text: `Intranet browser disarmed (ok=${value.ok})` }],
    },
    async execute(_args, exec) {
      void exec
      return { url: '', ok: true }
    },
  }))
}
