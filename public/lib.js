// Small, dependency-free helpers: tRPC over the same-origin proxy, ABI encoding, wallet, markdown.

// --- tRPC (superjson transport; we only read `json`, bigints arrive as strings) ---
const memo = new Map()
let freshUntil = 0
// after a transaction: skip the in-page and the server cache for a few seconds
export const forget = (ms = 8000) => (memo.clear(), (freshUntil = Date.now() + ms))
export async function q(path, input, { fresh = false } = {}) {
  const url = `/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input ?? null } }))}`
  fresh ||= Date.now() < freshUntil
  if (!fresh && memo.has(url)) return memo.get(url)
  const p = fetch(url, { credentials: 'same-origin', headers: fresh ? { 'cache-control': 'no-cache' } : {} }).then(unwrap)
  memo.set(url, p)
  p.catch(() => memo.delete(url))
  setTimeout(() => memo.delete(url), 30_000)
  return p
}
export async function m(path, input) {
  const r = await fetch(`/api/trpc/${path}?batch=1`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 0: { json: input ?? null } }),
  })
  memo.clear()
  return unwrap(r)
}
async function unwrap(r) {
  const body = await r.json().catch(() => null)
  const item = Array.isArray(body) ? body[0] : body
  if (item?.error) {
    const e = new Error(item.error.json?.message || 'request failed')
    e.code = item.error.json?.data?.code
    throw e
  }
  if (!r.ok && !item?.result) throw new Error(`http ${r.status}`)
  return item.result.data.json
}

// --- ABI encoding (uint256 / bool / address / string) ---
const hex = (n, bytes = 32) => BigInt(n).toString(16).padStart(bytes * 2, '0')
const utf8 = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')
export function encode(selector, types, values) {
  let head = ''
  let tail = ''
  const headSize = types.length * 32
  types.forEach((t, i) => {
    const v = values[i]
    if (t === 'string') {
      const data = utf8(v)
      head += hex(headSize + tail.length / 2)
      tail += hex(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0')
    } else if (t === 'address') head += v.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    else if (t === 'bool') head += hex(v ? 1 : 0)
    else head += hex(v)
  })
  return selector + head + tail
}
export const word = (data, i = 0) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'))

// --- money ---
export function parseEth(s) {
  const [w, f = ''] = String(s).trim().split('.')
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f) || (!w && !f)) throw new Error('invalid amount')
  return BigInt(w || 0) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))
}
export function fmtEth(wei, digits = 5) {
  const v = Number(BigInt(wei ?? 0)) / 1e18
  if (v === 0) return '0'
  if (v < 10 ** -digits) return `<${10 ** -digits}`
  return String(+v.toFixed(digits))
}
export const fmtUsd = (v) =>
  '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// --- wallet: EIP-6963 discovery with window.ethereum fallback ---
export const wallets = new Map()
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => wallets.set(e.detail.info.rdns, e.detail))
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}
export function listWallets() {
  const list = [...wallets.values()]
  if (!list.length && window.ethereum)
    list.push({ info: { name: 'browser wallet', rdns: 'injected', icon: '' }, provider: window.ethereum })
  return list
}

export async function switchChain(provider, chain) {
  const id = '0x' + chain.id.toString(16)
  if ((await provider.request({ method: 'eth_chainId' })) === id) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] })
  } catch (e) {
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw e
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: id, chainName: chain.label, rpcUrls: [chain.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: [chain.explorer] }],
    })
  }
}

export async function waitReceipt(provider, hash) {
  for (let i = 0; i < 180; i++) {
    const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null)
    if (r) {
      if (r.status !== '0x1') throw new Error('transaction reverted')
      return r
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error('timed out waiting for the transaction')
}

export async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

// --- DOM ---
export const $ = (s, el = document) => el.querySelector(s)
export const $$ = (s, el = document) => [...el.querySelectorAll(s)]
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export function ago(d) {
  const s = (Date.now() - new Date(typeof d === 'number' && d < 1e12 ? d * 1000 : d)) / 1000
  if (!isFinite(s)) return ''
  for (const [n, u] of [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']])
    if (s >= n) return `${Math.floor(s / n)}${u} ago`
  return 'just now'
}

// --- markdown: escape first, then a small safe subset ---
const safeUrl = (u) => (/^(https?:|ipfs:|\/)/i.test(u) ? u.replace(/^ipfs:\/\//i, 'https://ipfs.io/ipfs/') : '#')
function inline(s) {
  const codes = []
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img loading="lazy" alt="${a}" src="${safeUrl(u)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener nofollow ugc">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,!?;:'"])/g, '$1<a href="$2" target="_blank" rel="noopener nofollow ugc">$2</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`)
}
export function md(src) {
  const lines = esc(src).replace(/\r/g, '').split('\n')
  let out = ''
  let list = null
  let para = []
  const flush = () => {
    if (para.length) out += `<p>${para.map(inline).join('<br>')}</p>`
    para = []
    if (list) out += `</${list}>`
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^```/.test(l)) {
      flush()
      const code = []
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i])
      out += `<pre><code>${code.join('\n')}</code></pre>`
    } else if (/^#{1,6}\s/.test(l)) {
      flush()
      out += `<h3>${inline(l.replace(/^#+\s*/, ''))}</h3>`
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = [] }
      const t = /^\s*\d/.test(l) ? 'ol' : 'ul'
      if (list !== t) { if (list) out += `</${list}>`; out += `<${t}>`; list = t }
      out += `<li>${inline(l.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}</li>`
    } else if (/^&gt;\s?/.test(l)) {
      flush()
      out += `<blockquote>${inline(l.replace(/^&gt;\s?/, ''))}</blockquote>`
    } else if (!l.trim()) flush()
    else if (/^(-{3,}|\*{3,})$/.test(l.trim())) { flush(); out += '<hr>' }
    else {
      if (list) { out += `</${list}>`; list = null }
      para.push(l)
    }
  }
  flush()
  return out
}

// --- keccak-256 (for checksummed addresses) ---
const RC = ['1', '8082', '800000000000808a', '8000000080008000', '808b', '80000001', '8000000080008081', '8000000000008009', '8a', '88', '80008009', '8000000a',
  '8000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080', '800a', '800000008000000a', '8000000080008081',
  '8000000000008080', '80000001', '8000000080008008'].map((h) => BigInt('0x' + h))
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt)
const M64 = (1n << 64n) - 1n
const rotl = (x, n) => (n ? ((x << n) | (x >> (64n - n))) & M64 : x)
export function keccak256(bytes) {
  const rate = 136
  const p = new Uint8Array(Math.floor(bytes.length / rate + 1) * rate)
  p.set(bytes)
  p[bytes.length] ^= 1
  p[p.length - 1] ^= 0x80
  const s = Array(25).fill(0n)
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(p[off + i * 8 + b])
      s[i] ^= v
    }
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20])
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n)
        for (let y = 0; y < 25; y += 5) s[y + x] ^= D
      }
      const B = Array(25)
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y])
      for (let i = 0; i < 25; i++) s[i] = B[i] ^ (~B[((i % 5) + 1) % 5 + 5 * Math.floor(i / 5)] & M64 & B[((i % 5) + 2) % 5 + 5 * Math.floor(i / 5)])
      s[0] ^= RC[r]
    }
  }
  let out = ''
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 255n).toString(16).padStart(2, '0')
  return out
}
export function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '')
  const h = keccak256(new TextEncoder().encode(a))
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')
}
