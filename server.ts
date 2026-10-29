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

// --- HTML shell with per-page meta -------------------------------------------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const CHAINS: Record<string, number> = { mainnet: 1, arbitrum: 42161, base: 8453 }

type Meta = { title: string; desc: string; image?: string; embed?: string; button?: string }
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
  const og = (path: string, params: Record<string, string>, format: string) => `${url.origin}/api/og/${path}?${new URLSearchParams(params)}&imageFormat=${format}`
  let m
  if ((m = url.pathname.match(/^\/(mainnet|arbitrum|base)\/bounty\/(\d+)\/?$/))) {
    const chainId = CHAINS[m[1]]
    const [b, price, parts] = await Promise.all([
      get('bounties.fetch', { id: Number(m[2]), chainId }),
      get('web3.fetchPrice', { currency: 'eth' }),
      get('bounties.participations', { bountyId: Number(m[2]), chainId }),
    ])
    if (!b?.title) return STATIC['/']
    const eth = Number(BigInt(b.amount)) / 1e18
    const params = {
      title: String(b.title).slice(0, 100), amount: String(b.amount), chainId: String(chainId), currencyRate: String(price || 0),
      participants: (parts || []).map((p: { userAddress: string }) => p.userAddress).join(','),
    }
    return {
      title: `${b.title} | poidh`,
      desc: cut(`${+eth.toFixed(5)} eth${price ? ` ($${(eth * price).toFixed(2)})` : ''} bounty${b.inProgress ? ', open for claims' : ''}. ${clean(b.description)}`, 200),
      image: og('bounty', params, 'og'), embed: og('bounty', params, 'preview'), button: b.inProgress ? 'view bounty' : 'see the winner',
    }
  }
  if ((m = url.pathname.match(/^\/account\/(0x[0-9a-fA-F]{40})\/?$/))) {
    const address = m[1].toLowerCase()
    const [users, name, stats, counts] = await Promise.all([
      get('neynar.usersData', { addresses: [address] }), get('web3.fetchHumanReadableName', { address }),
      get('accounts.stats', { address }), get('accounts.activitiesCount', { address }),
    ])
    const u = users?.[0]
    const who = u?.farcasterTag || u?.gwei || u?.wei || u?.ens || u?.degenName || name || `${address.slice(0, 6)}…${address.slice(-4)}`
    const params = { address, poidhScore: String(stats?.poidhScore ?? 0), totalBounties: String(counts?.bounties ?? 0), totalClaims: String(counts?.claims ?? 0) }
    return {
      title: `${who} | poidh`,
      desc: `${who} on poidh: ${Number(stats?.poidhScore || 0).toLocaleString()} poidh score, ${counts?.bounties ?? 0} bounties, ${counts?.claims ?? 0} claims, $${(stats?.eth?.totalEarn?.amountUSD ?? 0).toFixed(2)} earned.`,
      image: og('account', params, 'og'), embed: og('account', params, 'preview'), button: 'view profile',
    }
  }
  if ((m = url.pathname.match(/^\/a\/([^/]+)\/?$/))) {
    const album = decodeURIComponent(m[1]).toLowerCase().slice(0, 40)
    return {
      title: `#${album} bounties | poidh`, desc: `${album} bounties on poidh: see the open ones, the votes in progress and the past winners.`,
      image: og('album', { album }, 'og'), embed: og('album', { album }, 'preview'), button: `see #${album}`,
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
  const image = meta.image || url.origin + '/og.png'
  const embedImage = meta.embed || url.origin + '/embed.png'
  // warm poidh's slow image renders (up to ~10 s) so the crawler's follow-up fetch is instant
  for (const i of [meta.image, meta.embed]) if (i && !cache.has(new URL(i).pathname + new URL(i).search)) fetchInto(new URL(i).pathname + new URL(i).search, req).catch(() => {})
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
    if (url.pathname === '/upload' && req.method === 'POST') return upload(req, url)
    if (url.pathname.startsWith('/u/')) return uploaded(url.pathname.slice(3))
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
