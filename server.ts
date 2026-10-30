// Static files + a caching same-origin proxy to poidh.xyz (it sends no CORS headers).
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdirSync } from 'node:fs'

const UPSTREAM = process.env.UPSTREAM || 'https://poidh.xyz'
const PORT = Number(process.env.PORT || 3000)
const DIR = new URL('./public/', import.meta.url).pathname
const VERSION = (process.env.GIT_SHA || String(Date.now())).slice(0, 8)
const TTL = 15_000 // fresh window for public API GETs; stale ones are served while refreshing
const MAX_STALE = 10 * 60_000
const PUBLIC_URL = process.env.PUBLIC_URL // e.g. https://poidh.borodutch.com behind a TLS proxy
const CRAWLER = /bot|crawl|spider|preview|facebookexternalhit|slack|discord|telegram|whatsapp|farcaster|warpcast|embed|okhttp|curl|python|go-http/i
// Farcaster domain association (JSON {header, payload, signature}), signed by the account that owns the mini app
const ASSOCIATION = process.env.FARCASTER_ACCOUNT_ASSOCIATION ? JSON.parse(process.env.FARCASTER_ACCOUNT_ASSOCIATION) : undefined

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', json: 'application/json',
  webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8',
}

type Asset = { body: Uint8Array; br?: Uint8Array; gz?: Uint8Array; type: string }
const assets = new Map<string, Asset>()
const packed = (body: Uint8Array, type: string): Asset =>
  /text|json|svg|javascript/.test(type) && body.length > 512
    ? { body, type, br: brotliCompressSync(body), gz: gzipSync(body) }
    : { body, type }
for (const f of new Bun.Glob('**/*').scanSync(DIR)) {
  let body: Uint8Array = await Bun.file(DIR + f).bytes()
  if (/\.(html|js|css)$/.test(f)) body = new TextEncoder().encode(new TextDecoder().decode(body).replaceAll('__V__', VERSION))
  assets.set('/' + f, packed(body, types[f.split('.').pop()!] || 'application/octet-stream'))
}
const shell = new TextDecoder().decode(assets.get('/index.html')!.body)

function send(req: Request, a: Asset, headers: Record<string, string> = {}, status = 200) {
  const enc = req.headers.get('accept-encoding') || ''
  const h: Record<string, string> = { 'content-type': a.type, vary: 'accept-encoding', ...headers }
  if (a.br && enc.includes('br')) return new Response(a.br, { status, headers: { ...h, 'content-encoding': 'br' } })
  if (a.gz && enc.includes('gzip')) return new Response(a.gz, { status, headers: { ...h, 'content-encoding': 'gzip' } })
  return new Response(a.body, { status, headers: h })
}

// --- API proxy -------------------------------------------------------------
// Procedures whose answer depends on the session cookie are never cached.
const PERSONAL = /(^|,)(auth\.|admin\.|zkpassport\.)/
type Cached = { at: number; status: number; type: string; asset: Asset; pending?: Promise<void> }
const cache = new Map<string, Cached>()

function upstreamHeaders(req: Request) {
  const h = new Headers()
  for (const k of ['content-type', 'cookie', 'accept', 'trpc-accept', 'x-trpc-source', 'user-agent'])
    if (req.headers.get(k)) h.set(k, req.headers.get(k)!)
  h.set('origin', UPSTREAM)
  h.set('referer', UPSTREAM + '/')
  return h
}

async function fetchInto(key: string, req: Request) {
  const r = await fetch(UPSTREAM + key, { headers: upstreamHeaders(req) })
  const type = r.headers.get('content-type') || 'application/json'
  const body = new Uint8Array(await r.arrayBuffer())
  if (r.status < 500) cache.set(key, { at: Date.now(), status: r.status, type, asset: packed(body, type) })
  if (cache.size > 5000) for (const k of [...cache.keys()].slice(0, 1000)) cache.delete(k)
  return { status: r.status, type, asset: packed(body, type) }
}

async function proxy(req: Request, url: URL) {
  const key = url.pathname + url.search
  const proc = url.pathname.startsWith('/api/trpc/') ? url.pathname.slice(10) : ''
  const cacheable = req.method === 'GET' && (proc ? !PERSONAL.test(proc) : url.pathname.startsWith('/api/og/'))
  if (cacheable) {
    const hit = req.headers.get('cache-control') === 'no-cache' ? undefined : cache.get(key)
    const age = hit ? Date.now() - hit.at : Infinity
    if (hit && age < MAX_STALE) {
      if (age > TTL && !hit.pending)
        hit.pending = fetchInto(key, req).then(() => {}, () => {}).finally(() => (hit.pending = undefined))
      return send(req, hit.asset, { 'cache-control': 'no-cache', 'x-cache': age > TTL ? 'stale' : 'hit' }, hit.status)
    }
    const fresh = await fetchInto(key, req)
    return send(req, fresh.asset, { 'cache-control': 'no-cache', 'x-cache': 'miss' }, fresh.status)
  }
  // Mutations carry the session cookie: only accept them from our own pages.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.get('origin') !== url.origin)
    return new Response('bad origin', { status: 403 })
  const r = await fetch(UPSTREAM + key, {
    method: req.method, headers: upstreamHeaders(req),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
  })
  const h = new Headers({ 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' })
  // The session cookie is set for poidh.xyz; re-scope it to this host.
  for (const c of r.headers.getSetCookie()) h.append('set-cookie', c.replace(/;\s*domain=[^;]*/i, ''))
  return new Response(r.body, { status: r.status, headers: h })
}

// --- claim media: claim.url points at metadata json, an image or a video -------
type Media = { src: string; video: boolean } | null
const DATA = process.env.DATA_DIR || './data'
const MEDIA_LOG = `${DATA}/media.jsonl`
const media = new Map<string, Media>()
// resolutions never change (ipfs), so they survive restarts in an append-only log
if (await Bun.file(MEDIA_LOG).exists())
  for (const line of (await Bun.file(MEDIA_LOG).text()).split('\n'))
    try { const [k, v] = JSON.parse(line); media.set(k, v) } catch {}
const mediaLog = Bun.file(MEDIA_LOG).writer()
const VIDEO = /\.(mp4|mov|webm|ogg)(\?.*)?$/i
const isPrivate = (ip: string) =>
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ||
  /^(::1?$|f[cd]|fe80|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip)
async function publicUrl(u: string) {
  const url = new URL(u)
  if (!/^https?:$/.test(url.protocol)) return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  return ips.length > 0 && !ips.some(isPrivate)
}
// fetch that refuses private addresses, also after redirects
async function safeFetch(u: string, timeout = 8000): Promise<Response & { finalUrl?: string }> {
  for (let i = 0; i < 4; i++) {
    if (!(await publicUrl(u).catch(() => false))) throw new Error('blocked')
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeout) })
    const next = r.status >= 300 && r.status < 400 && r.headers.get('location')
    if (!next) return Object.assign(r, { finalUrl: u })
    r.body?.cancel()
    u = new URL(next, u).href
  }
  throw new Error('too many redirects')
}
const ipfs = (u: string) => u.trim().replace(/^ipfs:\/\//i, 'https://ipfs.io/ipfs/')
async function resolveMedia(u: string): Promise<Media> {
  u = ipfs(u)
  if (VIDEO.test(u)) return { src: u, video: true }
  const r = await safeFetch(u)
  const type = r.headers.get('content-type') || ''
  if (type.startsWith('video/')) return r.body?.cancel(), { src: u, video: true }
  if (type.startsWith('image/')) return r.body?.cancel(), { src: u, video: false }
  if (Number(r.headers.get('content-length') || 0) > 500_000) return r.body?.cancel(), null
  const text = (await r.text()).slice(0, 500_000)
  try {
    const image = JSON.parse(text)?.image
    if (typeof image === 'string' && image) return { src: ipfs(image), video: VIDEO.test(image) }
  } catch {}
  const found = text.match(/https?:\/\/[^\s"]+\/ipfs\/[a-zA-Z0-9]+[^\s"]*/g)
  if (found) {
    const v = found.find((x) => VIDEO.test(x))
    return { src: v || found[0], video: !!v }
  }
  return null
}
const resolving = new Map<string, Promise<Media | undefined>>()
function mediaFor(u: string): Promise<Media | undefined> {
  if (media.has(u)) return Promise.resolve(media.get(u)!)
  if (!resolving.has(u))
    resolving.set(u, resolveMedia(u).then((m) => {
      media.set(u, m)
      if (m && !m.video && !/\.gif(\?|$)/i.test(m.src)) makeThumb(m.src, 640)
      mediaLog.write(JSON.stringify([u, m]) + '\n')
      mediaLog.flush()
      return m
    }, () => undefined).finally(() => resolving.delete(u)))
  return resolving.get(u)!
}
// GET /resolve?u=a&u=b → {a: media, b: media}
async function resolve(req: Request, url: URL) {
  const us = [...new Set(url.searchParams.getAll('u'))].slice(0, 60)
  const out = Object.fromEntries(await Promise.all(us.map(async (u) => [u, await mediaFor(u)])))
  const done = us.every((u) => out[u] !== undefined)
  return send(req, packed(new TextEncoder().encode(JSON.stringify(out)), types.json), { 'cache-control': done ? 'public, max-age=86400' : 'no-store' })
}

// GET /thumb?u=<image>: a small webp made with libvips, cached on disk; falls back to the original
const THUMBS = `${DATA}/thumbs`
mkdirSync(THUMBS, { recursive: true })
// at most 6 vips jobs at once; the rest wait their turn instead of falling back to multi-MB originals
let active = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>) {
  if (active >= 6) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}
const making = new Map<string, Promise<boolean>>()
const thumbName = (u: string, size: number) => new Bun.CryptoHasher('sha256').update(size + u).digest('hex') + '.webp'
function makeThumb(u: string, size: number): Promise<boolean> {
  const name = thumbName(u, size)
  if (!making.has(name))
    making.set(name, slot(async () => {
      if (await Bun.file(`${THUMBS}/${name}`).exists()) return true
      const r = await safeFetch(u, 20000)
      const type = r.headers.get('content-type') || ''
      if (!/^image\/(jpeg|png|webp|avif|heic)/.test(type) || Number(r.headers.get('content-length') || 0) > 40_000_000) return r.body?.cancel(), false
      const src = `${THUMBS}/${name}.src`
      await Bun.write(src, r)
      await Bun.spawn(['vipsthumbnail', src, '--size', `${size}x${size}`, '-o', `${THUMBS}/${name}[Q=78,strip]`], { stderr: 'ignore' }).exited
      await Bun.file(src).delete().catch(() => {})
      return Bun.file(`${THUMBS}/${name}`).exists()
    }).catch(() => false).finally(() => making.delete(name)))
  return making.get(name)!
}
async function thumb(req: Request, url: URL) {
  const u = url.searchParams.get('u') || ''
  const size = url.searchParams.get('w') === '96' ? 96 : 640
  if (!/^https?:/.test(u)) return new Response('bad url', { status: 400 })
  const headers = { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' }
  const path = `${THUMBS}/${thumbName(u, size)}`
  if ((await Bun.file(path).exists()) || (await makeThumb(u, size))) return new Response(Bun.file(path), { headers })
  return Response.redirect(u, 302)
}

// --- claim uploads, stored by content hash ---------------------------------------
const UPLOADS = `${DATA}/uploads`
mkdirSync(UPLOADS, { recursive: true })
const MAGIC: [string, RegExp, (b: Uint8Array) => boolean][] = [
  ['jpg', /^image\/jpe?g$/, (b) => b[0] === 0xff && b[1] === 0xd8],
  ['png', /^image\/png$/, (b) => b[0] === 0x89 && b[1] === 0x50],
  ['gif', /^image\/gif$/, (b) => b[0] === 0x47 && b[1] === 0x49],
  ['webp', /^image\/webp$/, (b) => b[8] === 0x57 && b[9] === 0x45],
  ['mp4', /^video\/(mp4|quicktime)$/, (b) => b[4] === 0x66 && b[5] === 0x74],
  ['webm', /^video\/webm$/, (b) => b[0] === 0x1a && b[1] === 0x45],
]
const FILE_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' }
const uploadsBy = new Map<string, number[]>()
async function upload(req: Request, url: URL) {
  if (req.headers.get('origin') !== url.origin) return new Response('bad origin', { status: 403 })
  // ponytail: in-memory per-ip limit, resets on restart
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local'
  const recent = (uploadsBy.get(ip) || []).filter((t) => t > Date.now() - 3600_000)
  if (recent.length >= 30) return new Response('too many uploads, try again later', { status: 429 })
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.length > 50 * 1024 * 1024) return new Response('max file size is 50 mb', { status: 413 })
  const type = req.headers.get('content-type') || ''
  const kind = MAGIC.find(([, t, ok]) => t.test(type) && ok(body))
  if (!kind) return new Response('only jpg, png, gif, webp, mp4 or webm files', { status: 415 })
  uploadsBy.set(ip, [...recent, Date.now()])
  const name = `${new Bun.CryptoHasher('sha256').update(body).digest('hex')}.${kind[0]}`
  const file = Bun.file(`${UPLOADS}/${name}`)
  if (!(await file.exists())) await Bun.write(file, body)
  return Response.json({ url: `${url.origin}/u/${name}` })
}
async function uploaded(name: string) {
  const m = name.match(/^([0-9a-f]{64})\.(jpg|png|gif|webp|mp4|webm)$/)
  const file = m && Bun.file(`${UPLOADS}/${name}`)
  if (!file || !(await file.exists())) return new Response('not found', { status: 404 })
  return new Response(file, {
    headers: { 'content-type': FILE_TYPES[m![2]], 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' },
  })
}

// --- bounty drafts: JSON that poidh pins to IPFS (POST /api/bounty-drafts), shown at /d/<cid> --------
// The CID is a raw-codec sha256 one, so the bytes are checked against it and kept forever.
const DRAFTS = `${DATA}/drafts`
mkdirSync(DRAFTS, { recursive: true })
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function rawCid(bytes: Uint8Array) {
  const b = [0x01, 0x55, 0x12, 0x20, ...new Bun.CryptoHasher('sha256').update(bytes).digest()]
  let out = 'b', acc = 0, bits = 0
  for (const x of b) for (acc = (acc << 8) | x, bits += 8; bits >= 5; bits -= 5) out += B32[(acc >>> (bits - 5)) & 31]
  return bits ? out + B32[(acc << (5 - bits)) & 31] : out
}
type Draft = { creator: string; title: string; description: string; amount: string; chain: 'mainnet' | 'base' | 'arbitrum'; isOpenBounty: boolean; album: string; createdAt: string }
async function draft(cid: string): Promise<Draft | null> {
  if (!/^bafkrei[a-z2-7]{52}$/.test(cid)) return null
  const file = Bun.file(`${DRAFTS}/${cid}.json`)
  let bytes = (await file.exists()) ? await file.bytes() : undefined
  if (!bytes) {
    const r = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`, { redirect: 'error', signal: AbortSignal.timeout(12_000) })
    if (!r.ok) throw new Error(`gateway ${r.status}`)
    bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes.length > 30_000 || rawCid(bytes) !== cid) return null
    await Bun.write(file, bytes)
  }
  const d = JSON.parse(new TextDecoder().decode(bytes))
  const ok = d?.type === 'poidh-bounty-draft' && /^0x[0-9a-fA-F]{40}$/.test(d.creator) && typeof d.title === 'string' && typeof d.description === 'string' &&
    /^\d+(\.\d{1,18})?$/.test(d.amount) && ['mainnet', 'base', 'arbitrum'].includes(d.chain) && typeof d.isOpenBounty === 'boolean' && typeof (d.album ?? '') === 'string'
  return ok ? { ...d, creator: d.creator.toLowerCase(), album: d.album || '' } : null
}
async function draftJson(cid: string) {
  const d = await draft(cid).catch(() => undefined)
  if (d === undefined) return new Response('ipfs gateway error', { status: 502 })
  if (!d) return new Response('not found', { status: 404 })
  return Response.json(d, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
}

// --- Farcaster mini app ----------------------------------------------------------
const manifest = (origin: string) => ({
  ...(ASSOCIATION ? { accountAssociation: ASSOCIATION } : {}),
  miniapp: {
    version: '1', name: 'poidh', subtitle: 'pics or it didn\'t happen', description: 'social bounties for fun. post a bounty with eth, anyone can claim it with a pic.',
    iconUrl: `${origin}/icon.png`, homeUrl: origin, imageUrl: `${origin}/embed.png`, buttonTitle: 'open poidh',
    splashImageUrl: `${origin}/splash.png`, splashBackgroundColor: '#2a81d5', heroImageUrl: `${origin}/og.png`, ogImageUrl: `${origin}/og.png`,
    ogTitle: 'poidh', ogDescription: 'social bounties for fun', tagline: 'pics or it didn\'t happen', primaryCategory: 'social',
    tags: ['bounties', 'social', 'base', 'photos', 'onchain'], requiredChains: ['eip155:8453', 'eip155:42161', 'eip155:1'],
    requiredCapabilities: ['actions.ready', 'wallet.getEthereumProvider'],
  },
})
const embed = (url: string, image: string, title: string, type: 'launch_miniapp' | 'launch_frame') =>
  JSON.stringify({ version: type === 'launch_frame' ? 'next' : '1', imageUrl: image, button: { title, action: { type, name: 'poidh', url, splashImageUrl: new URL('/splash.png', url).href, splashBackgroundColor: '#2a81d5' } } })

// --- share cards: our own og/embed images. librsvg draws the svg, pango draws user text (keeps color emoji) ---
type Card = {
  title: string; by?: string; byPic?: string; avatar?: string; photos?: string[]; photoLabel?: string
  pills: [string, string?][]; stats: [string, string][]
}
const RED = '#d63a40', GREEN = '#13804f'
const CARDS = `${DATA}/cards`
mkdirSync(CARDS, { recursive: true })
const SIZES = { og: [1200, 630], embed: [1200, 800] } as const
const LOGO = (await Bun.file(DIR + 'logo.svg').text()).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
const pngSize = (b: Uint8Array) => [new DataView(b.buffer, b.byteOffset).getUint32(16), new DataView(b.buffer, b.byteOffset).getUint32(20)]
const dataUri = async (file: string, type: string) => `data:${type};base64,${Buffer.from(await Bun.file(file).bytes()).toString('base64')}`

// user text as a png: `size` px at most, shrunk (pango autofit) when it would be taller than maxH
async function text(file: string, s: string, font: string, size: number, w: number, maxH: number, color = '#ffffff') {
  const markup = `<span foreground="${color}">${xml(s)}</span>`
  const run = (fit: string[]) => Bun.spawn(['vips', 'text', file, markup, '--font', `${font} ${size}`, '--width', String(w), '--wrap', 'word-char', '--rgba', ...fit], { stderr: 'ignore' }).exited
  await run([])
  let [tw, th] = pngSize(await Bun.file(file).bytes())
  if (th > maxH) await run(['--height', String(maxH)]), ([tw, th] = pngSize(await Bun.file(file).bytes()))
  return { w: tw, h: th, href: await dataUri(file, 'image/png') }
}
const thumbFile = async (u: string | undefined, size: number) => (u && /^https?:/.test(u) && (await makeThumb(u, size)) ? `${THUMBS}/${thumbName(u, size)}` : undefined)
async function photoFor(urls: string[]) {
  const found = await Promise.all(urls.map(mediaFor))
  for (const m of found) if (m && !m.video && !/\.gif(\?|$)/i.test(m.src)) { const f = await thumbFile(m.src, 640); if (f) return f }
}

const drawing = new Map<string, Promise<string>>()
const cardKey = (card: Card, fmt: string) => sha(VERSION + fmt + JSON.stringify(card)).slice(0, 24)
function drawCard(card: Card, fmt: keyof typeof SIZES): Promise<string> {
  const key = cardKey(card, fmt)
  const out = `${CARDS}/${key}.jpg`
  // ponytail: rendered cards are never pruned (~100 kb each), add a sweep if the volume fills up
  if (!drawing.has(key))
    drawing.set(key, (async () => {
      if (await Bun.file(out).exists()) return out
      const [W, H] = SIZES[fmt], P = 64, tmp = `${CARDS}/${key}-`
      const [photo, avatar, byPic] = await Promise.all([photoFor(card.photos || []), thumbFile(card.avatar, 640), thumbFile(card.byPic, 96)])
      const pic = photo || avatar
      const picSize = !pic ? 0 : avatar ? (fmt === 'og' ? 300 : 380) : fmt === 'og' ? 440 : 540
      const textW = W - 2 * P - (pic ? picSize + 56 : 0)
      const svg: string[] = []
      // logo + pills
      svg.push(`<svg x="${P}" y="${P}" width="137" height="52" viewBox="0 0 100 38" fill="none">${LOGO}</svg>`)
      let x = P + 137 + 24
      for (const [label, fill] of card.pills) {
        const w = Math.round(label.length * 13.2 + 36)
        svg.push(`<rect x="${x}" y="${P + 6}" width="${w}" height="40" rx="20" fill="${fill || 'rgb(6,32,74)'}" fill-opacity="${fill ? 1 : 0.32}" stroke="#fff" stroke-opacity="${fill ? 0 : 0.22}"/>`,
          `<text x="${x + w / 2}" y="${P + 33}" text-anchor="middle" font-family="Geist Mono" font-size="22" fill="#fff">${xml(label)}</text>`)
        x += w + 12
      }
      // stats along the bottom, dropping the last ones that don't fit
      const statY = H - P - 108
      let sx = P
      for (const [value, label] of card.stats) {
        const w = Math.round(Math.max(value.length * 27.6, label.length * 13.2) + 52)
        if (sx + w > P + textW) break
        svg.push(`<rect x="${sx}" y="${statY}" width="${w}" height="108" rx="20" fill="rgb(6,32,74)" fill-opacity="0.32" stroke="#fff" stroke-opacity="0.22"/>`,
          `<text x="${sx + 26}" y="${statY + 58}" font-family="Geist Mono" font-weight="700" font-size="46" fill="#fff">${xml(value)}</text>`,
          `<text x="${sx + 26}" y="${statY + 90}" font-family="Geist Mono" font-size="22" fill="#fff" fill-opacity="0.8">${xml(label)}</text>`)
        sx += w + 16
      }
      // title, then the byline under it
      const titleY = P + 52 + 48
      const byH = card.by ? 64 : 0
      const t = await text(tmp + 't.png', card.title.toLowerCase(), 'Geist Mono Bold', 68, textW, statY - 40 - byH - titleY)
      svg.push(`<image x="${P}" y="${titleY}" width="${t.w}" height="${t.h}" href="${t.href}"/>`)
      if (card.by) {
        const bx = P + (byPic ? 52 : 0), by = titleY + t.h + 30
        const b = await text(tmp + 'b.png', card.by.toLowerCase(), 'Geist Mono', 28, textW - (bx - P), 40, '#dbe8f7')
        if (byPic) svg.push(`<clipPath id="bp"><circle cx="${P + 20}" cy="${by + b.h / 2}" r="20"/></clipPath>`,
          `<image x="${P}" y="${by + b.h / 2 - 20}" width="40" height="40" preserveAspectRatio="xMidYMid slice" clip-path="url(#bp)" href="${await dataUri(byPic, 'image/webp')}"/>`)
        svg.push(`<image x="${bx}" y="${by}" width="${b.w}" height="${b.h}" href="${b.href}"/>`)
      }
      // the claim pic as a tilted print, or the avatar in a ring
      if (pic) {
        const px = W - P - picSize, py = (H - picSize) / 2, href = await dataUri(pic, 'image/webp')
        if (avatar && !photo)
          svg.push(`<circle cx="${px + picSize / 2}" cy="${H / 2}" r="${picSize / 2}" fill="#fff" filter="url(#sh)"/>`,
            `<clipPath id="av"><circle cx="${px + picSize / 2}" cy="${H / 2}" r="${picSize / 2 - 10}"/></clipPath>`,
            `<image x="${px}" y="${py}" width="${picSize}" height="${picSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)" href="${href}"/>`)
        else {
          const label = card.photoLabel || '', lw = Math.round(label.length * 13.2 + 36)
          svg.push(`<g transform="rotate(3 ${px + picSize / 2} ${H / 2})"><rect x="${px}" y="${py}" width="${picSize}" height="${picSize}" rx="24" fill="#fff" filter="url(#sh)"/>`,
            `<clipPath id="ph"><rect x="${px + 12}" y="${py + 12}" width="${picSize - 24}" height="${picSize - 24}" rx="14"/></clipPath>`,
            `<image x="${px + 12}" y="${py + 12}" width="${picSize - 24}" height="${picSize - 24}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ph)" href="${href}"/>`,
            label && `<rect x="${px + 28}" y="${py + picSize - 68}" width="${lw}" height="40" rx="20" fill="${card.photoLabel === 'winning pic' ? GREEN : RED}"/><text x="${px + 28 + lw / 2}" y="${py + picSize - 41}" text-anchor="middle" font-family="Geist Mono" font-size="22" fill="#fff">${xml(label)}</text>`,
            `</g>`)
        }
      }
      const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f6fc0"/><stop offset="0.45" stop-color="#4b91da"/><stop offset="0.6" stop-color="#5294dc"/><stop offset="1" stop-color="#1f6fc0"/></linearGradient>
<radialGradient id="glow" cx="0.3" cy="0.2" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#04183c" flood-opacity="0.45"/></filter>
</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>${svg.join('')}</svg>`
      await Bun.write(tmp + 'card.svg', doc)
      await Bun.spawn(['vips', 'copy', tmp + 'card.svg', `${out}[Q=88,strip]`], { stderr: 'ignore' }).exited
      for (const f of ['t.png', 'b.png', 'card.svg']) await Bun.file(tmp + f).delete().catch(() => {})
      if (!(await Bun.file(out).exists())) throw new Error('card render failed')
      return out
    })().finally(() => drawing.delete(key)))
  return drawing.get(key)!
}
// GET /og/<page path>?f=og|embed: the share card for that page
async function cardImage(req: Request, url: URL) {
  const meta = await metaFor(req, new URL(url.pathname.slice(3) || '/', url.origin)).catch(() => undefined)
  const fmt = url.searchParams.get('f') === 'embed' ? 'embed' : 'og'
  const file = meta?.card && (await drawCard(meta.card, fmt).catch(() => undefined))
  if (!file) return Response.redirect(`${url.origin}/${fmt === 'embed' ? 'embed' : 'og'}.png`, 302)
  return new Response(Bun.file(file), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=3600' } })
}

// --- HTML shell with per-page meta -------------------------------------------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const CHAINS: Record<string, number> = { mainnet: 1, arbitrum: 42161, base: 8453 }

type Meta = { title: string; desc: string; card?: Card; button?: string }
const DEFAULT_DESC = 'social bounties for fun. post a bounty with eth, anyone can claim it with a pic, and the best proof gets paid onchain.'
const STATIC: Record<string, Meta> = {
  '/': { title: "poidh - pics or it didn't happen", desc: DEFAULT_DESC },
  '/feed': { title: 'activity | poidh', desc: 'everything happening on poidh right now: new bounties, claims, payouts, votes and comments.', button: 'see activity' },
  '/leaderboard': { title: 'leaderboard | poidh', desc: 'the top poidh hunters and issuers, ranked by eth earned, eth paid out and claims collected.', button: 'see the leaderboard' },
  '/create': { title: 'create a bounty | poidh', desc: 'describe what you want to see, put up eth, and the best pic wins. solo or open bounties on base, arbitrum and ethereum.', button: 'create a bounty' },
  '/explore': { title: 'search | poidh', desc: 'search poidh bounties and people.', button: 'search poidh' },
}
const clean = (s: unknown) => String(s || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*_`>~]/g, '').replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

async function metaFor(req: Request, url: URL): Promise<Meta> {
  const get = async (proc: string, input: unknown) => {
    const key = `/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`
    const hit = cache.get(key) ?? (await fetchInto(key, req))
    return JSON.parse(new TextDecoder().decode(hit.asset.body))[0]?.result?.data?.json
  }
  const person = async (address: string) => {
    const [users, name] = await Promise.all([get('neynar.usersData', { addresses: [address] }), get('web3.fetchHumanReadableName', { address })])
    const u = users?.[0]
    return { who: String(u?.farcasterTag || u?.gwei || u?.wei || u?.ens || u?.degenName || name || `${address.slice(0, 6)}…${address.slice(-4)}`), pic: u?.pfpUrl as string | undefined }
  }
  let m
  if ((m = url.pathname.match(/^\/(mainnet|arbitrum|base)\/bounty\/(\d+)\/?$/))) {
    const chainId = CHAINS[m[1]]
    const [b, price, parts, claims] = await Promise.all([
      get('bounties.fetch', { id: Number(m[2]), chainId }),
      get('web3.fetchPrice', { currency: 'eth' }),
      get('bounties.participations', { bountyId: Number(m[2]), chainId }),
      get('claims.fetchBountyClaims', { bountyId: Number(m[2]), chainId, limit: 9 }),
    ])
    if (!b?.title) return STATIC['/']
    const eth = Number(BigInt(b.amount)) / 1e18
    const items: { url: string; isAccepted: boolean }[] = claims?.items || []
    const nClaims = items.length + (claims?.nextCursor ? '+' : '')
    const status = b.isCanceled ? 'cancelled' : !b.inProgress ? 'paid out' : b.isVoting ? 'voting' : 'open for claims'
    const by = await person(String(b.issuer).toLowerCase())
    return {
      title: `${b.title} | poidh`,
      desc: cut(`${+eth.toFixed(5)} eth${price ? ` ($${(eth * price).toFixed(2)})` : ''} bounty${b.inProgress ? ', open for claims' : ''}. ${clean(b.description)}`, 200),
      card: {
        title: cut(String(b.title), 140), by: `by ${by.who}`, byPic: by.pic,
        pills: [[m[1] === 'mainnet' ? 'ethereum' : m[1]], [status, { voting: RED, 'open for claims': GREEN, 'paid out': GREEN }[status]]],
        stats: [
          [`${+eth.toFixed(5)} eth`, price ? `$${(eth * price).toFixed(2)}` : 'bounty'],
          [nClaims, nClaims == 1 ? 'claim' : 'claims'],
          ...(b.isMultiplayer ? [[String(parts?.length || 1), parts?.length == 1 ? 'contributor' : 'contributors'] as [string, string]] : []),
        ],
        // the winner first, then the newest claims
        photos: [...items.filter((c) => c.isAccepted), ...items.filter((c) => !c.isAccepted)].map((c) => c.url),
        photoLabel: items.some((c) => c.isAccepted) ? 'winning pic' : 'latest claim',
      },
      button: b.inProgress ? 'view bounty' : 'see the winner',
    }
  }
  if ((m = url.pathname.match(/^\/account\/(0x[0-9a-fA-F]{40})\/?$/))) {
    const address = m[1].toLowerCase()
    const [{ who, pic }, stats, counts] = await Promise.all([person(address), get('accounts.stats', { address }), get('accounts.activitiesCount', { address })])
    const earned = `$${(stats?.eth?.totalEarn?.amountUSD ?? 0).toFixed(2)}`
    return {
      title: `${who} | poidh`,
      desc: `${who} on poidh: ${Number(stats?.poidhScore || 0).toLocaleString()} poidh score, ${counts?.bounties ?? 0} bounties, ${counts?.claims ?? 0} claims, ${earned} earned.`,
      card: {
        title: who, by: `${address.slice(0, 6)}…${address.slice(-4)}`, avatar: pic, pills: [['profile']],
        stats: [[Number(stats?.poidhScore || 0).toLocaleString('en-US'), 'poidh score'], [String(counts?.bounties ?? 0), 'bounties'], [String(counts?.claims ?? 0), 'claims'], [earned, 'earned']],
      },
      button: 'view profile',
    }
  }
  if ((m = url.pathname.match(/^\/d\/([a-z2-7]+)\/?$/))) {
    const d = await draft(m[1])
    if (!d) return STATIC['/']
    const [by, price] = await Promise.all([person(d.creator), get('web3.fetchPrice', { currency: 'eth' })])
    return {
      title: `${d.title} (draft) | poidh`,
      desc: cut(`${d.amount} eth bounty draft, ready to post. ${clean(d.description)}`, 200),
      card: {
        title: cut(d.title, 140), by: `drafted by ${by.who}`, byPic: by.pic,
        pills: [[d.chain === 'mainnet' ? 'ethereum' : d.chain], ['draft', RED]],
        stats: [[`${d.amount} eth`, price ? `$${(+d.amount * price).toFixed(2)}` : 'bounty'], [d.isOpenBounty ? 'open' : 'solo', 'bounty']],
      },
      button: 'create this bounty',
    }
  }
  if ((m = url.pathname.match(/^\/a\/([^/]+)\/?$/))) {
    const album = decodeURIComponent(m[1]).toLowerCase().slice(0, 40)
    const c = await get('bounties.fetchAlbumCounts', { album })
    return {
      title: `#${album} bounties | poidh`, desc: `${album} bounties on poidh: see the open ones, the votes in progress and the past winners.`,
      card: { title: `#${album}`, by: 'bounties on poidh', pills: [['album']], stats: [[String(c?.open ?? 0), 'open'], [String(c?.progress ?? 0), 'voting'], [String(c?.past ?? 0), 'past']] },
      button: `see #${album}`,
    }
  }
  return STATIC[url.pathname.replace(/\/+$/, '') || '/'] || STATIC['/']
}

async function page(req: Request, url: URL) {
  // people get the page at once (the app loads its own data); link previews wait for the page's meta
  const ua = req.headers.get('user-agent') || ''
  const crawler = CRAWLER.test(ua) || !/mozilla/i.test(ua)
  const known = STATIC[url.pathname.replace(/\/+$/, '') || '/']
  const meta = known || !crawler ? known || STATIC['/'] : await metaFor(req, url).catch(() => STATIC['/'])
  const card = (f: 'og' | 'embed') => `${url.origin}/og${url.pathname}?${f === 'embed' ? 'f=embed&' : ''}v=${cardKey(meta.card!, f).slice(0, 10)}`
  const image = meta.card ? card('og') : url.origin + '/og.png'
  const embedImage = meta.card ? card('embed') : url.origin + '/embed.png'
  // draw the cards now so the crawler's follow-up image fetch is instant
  if (meta.card) for (const f of ['og', 'embed'] as const) drawCard(meta.card, f).catch(() => {})
  const here = url.origin + url.pathname
  const html = shell
    .replaceAll('__TITLE__', esc(meta.title))
    .replaceAll('__DESC__', esc(meta.desc))
    .replaceAll('__IMAGE__', esc(image))
    .replaceAll('__URL__', esc(here))
    .replaceAll('__ALT__', esc(cut(meta.title.replace(/ \| poidh$/, ''), 120)))
    .replace('__MINIAPP__', esc(embed(here, embedImage, meta.button || 'open poidh', 'launch_miniapp')))
    .replace('__FRAME__', esc(embed(here, embedImage, meta.button || 'open poidh', 'launch_frame')))
  return send(req, packed(new TextEncoder().encode(html), types.html), { 'cache-control': 'no-cache' })
}

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = PUBLIC_URL ? new URL(new URL(req.url).pathname + new URL(req.url).search, PUBLIC_URL) : new URL(req.url)
    if (url.pathname.startsWith('/api/')) return proxy(req, url).catch(() => new Response('upstream error', { status: 502 }))
    if (url.pathname === '/resolve') return resolve(req, url)
    if (url.pathname === '/thumb') return thumb(req, url)
    if (url.pathname.startsWith('/og/')) return cardImage(req, url)
    if (url.pathname === '/upload' && req.method === 'POST') return upload(req, url)
    if (url.pathname.startsWith('/u/')) return uploaded(url.pathname.slice(3))
    if (url.pathname.startsWith('/draft/')) return draftJson(url.pathname.slice(7))
    if (url.pathname === '/.well-known/farcaster.json') return Response.json(manifest(url.origin), { headers: { 'access-control-allow-origin': '*' } })
    const a = assets.get(url.pathname)
    if (a && url.pathname !== '/index.html')
      return send(req, a, { 'cache-control': url.searchParams.has('v') || url.pathname.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' })
    return page(req, url)
  },
})
// keep the home page's queries warm (same keys the client builds) so nobody waits after a deploy
const HOT: [string, unknown][] = [
  ['bounties.fetchAll', { status: 'open', sortType: 'value', limit: 12 }], ['claims.fetchLatest', { limit: 15 }],
  ['claims.fetchRecentPayouts', { limit: 12 }], ['web3.fetchPrice', { currency: 'eth' }], ['accounts.activities', { limit: 20 }],
]
const warmHome = () => {
  for (const [proc, input] of HOT)
    fetchInto(`/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`, new Request(UPSTREAM)).catch(() => {})
}
warmHome()
setInterval(warmHome, 60_000)
console.log(`poidh on :${PORT} → ${UPSTREAM}`)
