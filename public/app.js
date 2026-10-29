import { sfx, soundOn, setSound } from './sfx.js?v=__V__'
import { q, m, forget, checksum, encode, parseEth, fmtEth, fmtUsd, listWallets, wallets, switchChain, waitReceipt, rpc, $, $$, esc, short, ago, md } from './lib.js?v=__V__'

// --- protocol config ---------------------------------------------------------
const V3 = '0x5555fa783936c260f77385b4e153b9725fef1719'
const CHAINS = {
  8453: { id: 8453, slug: 'base', label: 'base', contract: V3, rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', color: '#0052ff' },
  42161: { id: 42161, slug: 'arbitrum', label: 'arbitrum', contract: V3, rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', color: '#28a0f0' },
  1: { id: 1, slug: 'mainnet', label: 'ethereum', contract: '0xE731dFadBFf20542E10D09D26Fc71445C70d4232', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', color: '#627eea' },
  666666666: { id: 666666666, slug: 'degen', label: 'degen', contract: '0x18e5585ca7ce31b90bc8bb7aaf84152857ce243f', rpc: 'https://rpc.degen.tips', explorer: 'https://explorer.degen.tips', color: '#a36efd', currency: 'degen', retired: true },
}
const BY_SLUG = Object.fromEntries(Object.values(CHAINS).map((c) => [c.slug, c]))
const LIVE = [8453, 42161, 1]
const SEL = {
  createSoloBounty: '0xd4ea4227', createOpenBounty: '0x8c1d93c5', joinOpenBounty: '0xa9b2c6eb', withdrawFromOpenBounty: '0xfaf0f5e9',
  createClaim: '0x83ffc9f2', acceptClaim: '0x1d260f8e', submitClaimForVote: '0x9e9251c8', voteClaim: '0xb7c8994d', resolveVote: '0x30f4ccac',
  cancelSoloBounty: '0xb1b4be97', cancelOpenBounty: '0xd496ec7a', claimRefundFromCancelledOpenBounty: '0x240b727e', withdraw: '0x3ccfd60b',
  pendingWithdrawals: '0xf3f43703',
}
const BOUNTY_CREATED = '0xd265c5d6a9224c4853317e9e3262b0605b45f0e87c8bfd17d020e54a87c439af'
const ERRORS = {
  '0x7c9a1cf9': 'you already voted', '0x861fbe13': 'this bounty was already paid out', '0x88bb2354': 'this bounty is closed', '0x93395f9c': 'bounty not found',
  '0xd11e9bde': 'claim already accepted', '0x0455eeee': 'claim not found', '0x4b087ad8': 'smart contract wallets cannot create bounties, use a regular wallet',
  '0x8f60bb0a': 'the issuer cannot claim their own bounty', '0xcbc448a1': 'the issuer cannot withdraw, cancel instead', '0x6c8c8d21': 'this bounty has the maximum number of contributors',
  '0x0fa2e38d': 'the minimum bounty is 0.001 eth', '0x7ec19a65': 'contribution is below the minimum', '0xa4675adf': 'no eth sent', '0x2fb19d77': 'you are not a contributor',
  '0xdcd2fc90': 'this open bounty is not cancelled', '0xa6901796': 'not an open bounty', '0x10c2a11b': 'not a solo bounty', '0xd0d04f60': 'nothing to withdraw',
  '0x089575c6': 'the vote would pass, wait for it to resolve', '0x7a19ed05': 'voting has ended', '0xb6c99482': 'voting is in progress', '0x0d0d217e': 'only the issuer can do that',
  '0xf4d678b8': 'insufficient balance',
}
const chainOf = (id) => CHAINS[id] || CHAINS[8453]
const bountyPath = (b) => `/${chainOf(b.chainId).slug}/bounty/${b.bountyId ?? b.id}`
const unit = (chainId) => chainOf(chainId).currency || 'eth'
const lc = (a) => String(a || '').toLowerCase()

// --- state ---------------------------------------------------------------------
const state = { account: null, provider: null, wallet: null, mini: null, prices: {}, session: null }
const app = $('#app')
let renderId = 0

async function price(cur = 'eth') {
  return (state.prices[cur] ??= q('web3.fetchPrice', { currency: cur }).catch(() => 0))
}
const usd = async (wei, chainId) => (Number(BigInt(wei || 0)) / 1e18) * (await price(unit(chainId)))

// --- people: names + avatars, fetched in one batch per render -----------------
const people = new Map()
const names = new Map()
function nameOf(a) {
  const u = people.get(lc(a))
  return u?.farcasterTag || u?.gwei || u?.wei || u?.ens || u?.degenName || names.get(lc(a)) || short(a)
}
function avatar(a, cls = 'av') {
  const u = people.get(lc(a))
  if (u?.pfpUrl) return `<img class="${cls}" src="/thumb?w=96&u=${esc(encodeURIComponent(u.pfpUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'${cls}',style:'background:${grad(a)}'}))">`
  return `<i class="${cls}" style="background:${grad(a)}"></i>`
}
function grad(a) {
  const h = parseInt(lc(a).slice(2, 8) || '0', 16)
  return `linear-gradient(135deg,hsl(${h % 360} 75% 60%),hsl(${(h >> 9) % 360} 80% 45%))`
}
const who = (a) => `<a class="who" href="/account/${esc(lc(a))}" data-who="${esc(lc(a))}">${avatar(a)}<span class="ellipsis">${esc(nameOf(a))}</span></a>`
const peopleLoading = new Map()
async function hydratePeople(root = app) {
  const all = [...new Set($$('[data-who]', root).map((e) => e.dataset.who))]
  const missing = all.filter((a) => !people.has(a) && !peopleLoading.has(a))
  if (missing.length) {
    const p = q('neynar.usersData', { addresses: missing }).then((list) => { for (const u of list || []) people.set(lc(u.address), u) }, () => {})
      .finally(() => missing.forEach((a) => (peopleLoading.delete(a), people.has(a) || people.set(a, null))))
    missing.forEach((a) => peopleLoading.set(a, p))
  }
  await Promise.all(all.map((a) => peopleLoading.get(a)))
  // no farcaster profile: try ens / .wei / .gwei / .degen names (the server caches these)
  const unnamed = all.filter((a) => !nameOf(a).includes('.') && nameOf(a) === short(a) && !names.has(a))
  unnamed.forEach((a) => names.set(a, null))
  await Promise.all(unnamed.map((a) => q('web3.fetchHumanReadableName', { address: a }).then((n) => n && names.set(a, n), () => {})))
  for (const el of $$('[data-name]', root)) if (people.get(el.dataset.name) || names.get(el.dataset.name)) el.textContent = nameOf(el.dataset.name)
  for (const el of $$('[data-who]', root)) if (people.get(el.dataset.who) || names.get(el.dataset.who)) el.innerHTML = avatar(el.dataset.who, el.dataset.cls || 'av') + (el.dataset.only ? '' : `<span class="ellipsis">${esc(nameOf(el.dataset.who))}</span>`)
}

// --- claim media: claim.url is metadata json, an image or a video ------------
const mediaCache = new Map()
async function resolveAll(urls) {
  const need = [...new Set(urls)].filter((u) => u && !mediaCache.has(u))
  if (need.length) {
    const p = fetch('/resolve?' + need.map((u) => 'u=' + encodeURIComponent(u)).join('&')).then((r) => r.json()).catch(() => ({}))
    for (const u of need) mediaCache.set(u, p.then((all) => all[u] ?? null))
  }
  return Promise.all(urls.map((u) => mediaCache.get(u) ?? null))
}
const thumbUrl = (src) => (/\.gif(\?|$)/i.test(src) || src.startsWith(location.origin + '/u/') ? src : '/thumb?u=' + encodeURIComponent(src))
// .fit = shimmer → blurred backdrop + the whole picture (contain); `cover` crops for small square tiles
function mediaEl(m, alt = '', cover = false) {
  if (!m) return `<div class="fit ready"><div class="ph" style="background:${grad('0x' + (alt.length * 7919).toString(16) + 'abc123')}"></div></div>`
  if (m.video) return `<div class="fit loading${cover ? ' cover' : ''}"><video class="fg" src="${esc(m.src)}#t=0.1" muted playsinline preload="metadata" loop></video></div>`
  const src = esc(thumbUrl(m.src))
  return `<div class="fit loading${cover ? ' cover' : ''}">${cover ? '' : `<img class="bg" src="${src}" alt="" aria-hidden="true" decoding="async">`}<img class="fg" src="${src}" alt="${esc(alt)}" decoding="async"></div>`
}
function wireMedia(fit, m) {
  const fg = fit.querySelector('.fg')
  if (!fg) return
  const ready = () => fit.classList.replace('loading', 'ready')
  if (fg.tagName === 'VIDEO') {
    fg.addEventListener('loadeddata', ready, { once: true })
    fg.addEventListener('mouseenter', () => fg.play().catch(() => {}))
    fg.addEventListener('mouseleave', () => fg.pause())
  } else if (fg.complete && fg.naturalWidth) ready()
  else fg.addEventListener('load', ready, { once: true })
  // metadata can point at a video without a video extension
  fg.addEventListener('error', () => {
    if (fg.tagName === 'VIDEO' || !m) return ready()
    m.video = true
    fit.outerHTML = mediaEl(m, '', fit.classList.contains('cover'))
  }, { once: true })
}
async function hydrateMedia(root = app) {
  const els = $$('[data-media]', root)
  for (const el of els) {
    el.removeAttribute('data-media')
    el.insertAdjacentHTML('afterbegin', '<div class="fit loading"></div>')
  }
  const list = await resolveAll(els.map((el) => el.dataset.src))
  els.forEach((el, i) => {
    el.querySelector('.fit')?.remove()
    el.insertAdjacentHTML('afterbegin', mediaEl(list[i], el.dataset.alt || '', el.classList.contains('tile') || el.classList.contains('thumb')))
    wireMedia(el.querySelector('.fit'), list[i])
  })
}
function lightbox(m) {
  const d = document.createElement('dialog')
  d.className = 'media'
  d.innerHTML = m.video ? `<video src="${esc(m.src)}" controls autoplay playsinline></video>` : `<img src="${esc(m.src)}" alt="">`
  d.onclick = () => d.close()
  d.onclose = () => d.remove()
  document.body.append(d)
  d.showModal()
}

// --- ui bits ---------------------------------------------------------------
function toast(msg, err = false) {
  $('.toast')?.remove()
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (err ? ' err' : ''), textContent: msg })
  if (err) sfx.error()
  document.body.append(t)
  setTimeout(() => t.remove(), err ? 6000 : 3500)
}
const done = (msg) => (toast(msg), sfx.success())
function sheet(html, onOpen) {
  sfx.open()
  const d = document.createElement('dialog')
  d.innerHTML = `<div class="sheet">${html}</div>`
  d.addEventListener('click', (e) => e.target === d && d.close())
  d.onclose = () => d.remove()
  document.body.append(d)
  d.showModal()
  onOpen?.(d)
  return d
}
const chainDot = (id) => `<i class="dot" title="${chainOf(id).label}" style="background:${chainOf(id).color}"></i>`
const plain = (s) => String(s || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*_`>~]/g, '').replace(/\s+/g, ' ').trim()
const skelGrid = (n = 6, h = 210) => `<div class="grid">${'<div class="skel" style="height:' + h + 'px"></div>'.repeat(n)}</div>`
const skelStrip = (n = 8) => `<div class="strip">${'<div class="tile skel"></div>'.repeat(n)}</div>`

function bountyCard(b, usdPrice) {
  const amt = fmtEth(b.amount)
  const badges = [
    b.isMultiplayer && '<span class="badge">open bounty</span>',
    b.isVoting && b.inProgress && '<span class="badge red">voting</span>',
    b.isCanceled && '<span class="badge">cancelled</span>',
    !b.inProgress && !b.isCanceled && '<span class="badge green">paid out</span>',
    b.hasClaims && b.inProgress && '<span class="badge">has claims</span>',
  ].filter(Boolean).join('')
  return `<a class="card" href="${bountyPath(b)}">
    <div class="row between"><span class="who" data-who="${esc(lc(b.issuer))}">${avatar(b.issuer)}<span class="ellipsis">${esc(nameOf(b.issuer))}</span></span><span class="dim" style="font-size:11px">${ago(b.createdAt)}</span></div>
    <h3>${esc(b.title)}</h3>
    <div class="desc">${esc(plain(b.description).slice(0, 400))}</div>
    ${badges ? `<div class="badges">${badges}</div>` : ''}
    ${b.acceptedClaim?.url ? `<div class="winner"><div class="thumb" data-media data-src="${esc(b.acceptedClaim.url)}" data-alt=""></div><span class="ellipsis"><span class="dim">winner</span> ${esc(b.acceptedClaim.title)}</span></div>` : ''}
    <div class="foot"><span class="amount">${amt} ${unit(b.chainId)}${usdPrice ? ` <small>${fmtUsd((Number(BigInt(b.amount)) / 1e18) * usdPrice)}</small>` : ''}</span><span class="row dim" style="font-size:11px;gap:6px">${chainDot(b.chainId)}${chainOf(b.chainId).label}</span></div>
  </a>`
}

// infinite list: calls load(cursor) → {items, nextCursor}; renders with render(items)
function infinite(container, load, render, empty = 'nothing here yet') {
  let cursor
  let busy = false
  let done = false
  const sentinel = document.createElement('div')
  sentinel.className = 'more'
  container.after(sentinel)
  const id = renderId
  async function next() {
    if (busy || done || id !== renderId) return
    busy = true
    sentinel.innerHTML = '<span class="spin"></span>'
    try {
      const r = await load(cursor)
      if (id !== renderId) return
      container.insertAdjacentHTML('beforeend', await render(r.items))
      if (!container.children.length) container.outerHTML = `<div class="empty">${empty}</div>`
      hydratePeople(container.parentElement || app)
      hydrateMedia(container.parentElement || app)
      cursor = r.nextCursor
      done = cursor == null || !r.items.length
    } catch (e) {
      sentinel.innerHTML = `<button class="btn sm">retry</button>`
      sentinel.firstChild.onclick = () => { busy = false; next() }
      return
    }
    busy = false
    sentinel.innerHTML = ''
    if (!done && sentinel.getBoundingClientRect().top < innerHeight + 600) next()
  }
  new IntersectionObserver((e) => e[0].isIntersecting && next(), { rootMargin: '600px' }).observe(sentinel)
  next()
}

// --- wallet ------------------------------------------------------------------
function setAccount(a) {
  state.account = a ? lc(a) : null
  const b = $('#connect')
  if (state.account) {
    b.innerHTML = `${avatar(state.account)}<span class="ellipsis" style="max-width:110px">${esc(nameOf(state.account))}</span>`
    b.dataset.who = state.account
    hydratePeople(document.body).then(() => b.dataset.who && (b.innerHTML = `${avatar(state.account)}<span class="ellipsis" style="max-width:110px">${esc(nameOf(state.account))}</span>`))
  } else {
    b.textContent = 'connect'
    delete b.dataset.who
  }
}
function useProvider(p, rdns) {
  state.provider = p
  state.wallet = rdns
  p.on?.('accountsChanged', (a) => (state.provider === p && setAccount(a[0]), route()))
}
async function connect() {
  if (state.provider && state.account) return state.account
  if (state.mini) {
    const a = await state.provider.request({ method: 'eth_requestAccounts' })
    setAccount(a[0])
    return state.account
  }
  const list = listWallets()
  return new Promise((resolve, reject) => {
    const mobile = /iphone|ipad|android/i.test(navigator.userAgent)
    const here = location.host + location.pathname
    const d = sheet(`<h2>connect a wallet</h2>
      ${list.length ? list.map((w, i) => `<button class="btn block" data-i="${i}" style="justify-content:flex-start">${w.info.icon ? `<img src="${esc(w.info.icon)}" width="22" height="22" alt="">` : ''}${esc(w.info.name)}</button>`).join('')
        : `<p class="muted">no wallet found in this browser.${mobile ? ' open poidh in your wallet app:' : ' install a wallet extension like rabby or metamask, or open poidh on your phone in a wallet app.'}</p>
           ${mobile ? `<a class="btn block" href="https://metamask.app.link/dapp/${esc(here)}">metamask</a><a class="btn block" href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}">coinbase wallet</a><a class="btn block" href="https://rnbwapp.com/dapp?url=${encodeURIComponent(location.href)}">rainbow</a>` : ''}`}
      <p class="dim" style="font-size:11px;margin:0">poidh never holds your funds. every action is a transaction you approve in your wallet.</p>`)
    d.addEventListener('close', () => !state.account && reject(new Error('not connected')))
    $$('[data-i]', d).forEach((b) => (b.onclick = async () => {
      const w = list[b.dataset.i]
      try {
        const a = await w.provider.request({ method: 'eth_requestAccounts' })
        useProvider(w.provider, w.info.rdns)
        try { localStorage.setItem('wallet', w.info.rdns) } catch {}
        setAccount(a[0])
        d.close()
        resolve(state.account)
        route()
      } catch (e) {
        toast(e.message || 'connection rejected', true)
      }
    }))
  })
}
async function autoConnect() {
  let rdns
  try { rdns = localStorage.getItem('wallet') } catch {}
  if (!rdns) return
  await new Promise((r) => setTimeout(r, 120)) // give wallets a moment to announce
  const w = wallets.get(rdns) || (rdns === 'injected' && window.ethereum && { provider: window.ethereum })
  if (!w) return
  const a = await w.provider.request({ method: 'eth_accounts' }).catch(() => [])
  if (a[0]) { useProvider(w.provider, rdns); setAccount(a[0]) }
}
function accountMenu() {
  const d = sheet(`<div class="row">${avatar(state.account, 'av lg')}<div class="grow"><h2 class="ellipsis">${esc(nameOf(state.account))}</h2><div class="dim ellipsis">${esc(state.account)}</div></div></div>
    <a class="btn block" href="/account/${state.account}">your profile</a>
    ${state.mini ? '' : '<button class="btn block" id="dc">disconnect</button>'}`)
  $$('a', d).forEach((a) => a.addEventListener('click', () => d.close()))
  $('#dc', d)?.addEventListener('click', () => {
    try { localStorage.removeItem('wallet') } catch {}
    state.provider = null
    setAccount(null)
    d.close()
    route()
  })
}

function revertReason(e) {
  const data = [e?.data?.data, e?.data, e?.error?.data, e?.data?.originalError?.data, e?.cause?.data].find((x) => typeof x === 'string' && x.startsWith('0x'))
  if (data && ERRORS[data.slice(0, 10)]) return ERRORS[data.slice(0, 10)]
  const msg = String(e?.message || e)
  for (const [sel, text] of Object.entries(ERRORS)) if (msg.includes(sel)) return text
  if (e?.code === 4001 || /reject|denied|cancel/i.test(msg)) return 'transaction rejected'
  if (/insufficient funds/i.test(msg)) return 'not enough eth in your wallet for this (plus gas)'
  return msg.slice(0, 200)
}
// sends one contract call, waits for it, returns the receipt
async function send(chainId, data, value = 0n, label = 'transaction') {
  await connect()
  const chain = chainOf(chainId)
  if (chain.retired) throw new Error(`${chain.label} bounties are read-only now`)
  const p = state.provider
  await switchChain(p, chain)
  const tx = { from: state.account, to: chain.contract, data, value: '0x' + BigInt(value).toString(16) }
  // simulate first so contract errors show up as words instead of a scary wallet warning
  const err = await p.request({ method: 'eth_call', params: [tx, 'latest'] }).then(() => null, (e) => e)
  if (err && (Object.values(ERRORS).includes(revertReason(err)) || /revert|insufficient funds/i.test(err.message))) throw new Error(revertReason(err))
  toast(`confirm the ${label} in your wallet`)
  const hash = await p.request({ method: 'eth_sendTransaction', params: [tx] })
  toast(`${label} sent, waiting for it to land…`)
  const receipt = await waitReceipt(p, hash)
  return receipt
}
async function act(btn, fn) {
  const label = btn.innerHTML
  btn.disabled = true
  btn.innerHTML = '<span class="spin"></span>'
  try {
    await fn()
  } catch (e) {
    if (e.message !== 'not connected') toast(revertReason(e), true)
  } finally {
    btn.disabled = false
    btn.innerHTML = label
  }
}
// the indexer lags a few seconds behind the chain
async function poll(check, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await check().catch(() => null)
    if (r) return r
    await new Promise((res) => setTimeout(res, 1500))
  }
  return null
}

// --- views -------------------------------------------------------------------
const WORDS = ['fun', 'art', 'memes', 'science', 'nature', 'travel', 'food', 'code', 'music', 'good deeds', 'the weird stuff']

async function home(params) {
  const tab = ['open', 'progress', 'past'].includes(params.get('tab')) ? params.get('tab') : 'open'
  const sort = params.get('sort') === 'date' ? 'date' : 'value'
  app.innerHTML = `
    <section class="hero">
      <h1>social bounties for <em id="word">fun</em></h1>
      <p>post a bounty with eth, anyone can claim it with a pic. pics or it didn't happen.</p>
      <div class="hero-cta"><a class="btn red" href="/create">create a bounty</a><button class="btn" id="how">how it works</button></div>
    </section>
    <div class="sec"><h2>latest claims</h2></div>
    <div id="latest">${skelStrip()}</div>
    <div class="sec"><h2>recent payouts</h2></div>
    <div id="payouts">${skelStrip()}</div>
    <div class="toolbar">
      <div class="tabs">${[['open', 'new'], ['progress', 'voting'], ['past', 'past']].map(([k, l]) => `<a href="?tab=${k}${sort === 'date' ? '&sort=date' : ''}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}</div>
      <select class="sel" id="sort" aria-label="sort"><option value="value">highest value</option><option value="date" ${sort === 'date' ? 'selected' : ''}>newest</option></select>
    </div>
    <div class="grid" id="bounties"></div>`
  let w = 0
  const id = renderId
  const spin = setInterval(() => (id !== renderId ? clearInterval(spin) : ($('#word') && ($('#word').textContent = WORDS[++w % WORDS.length]))), 2200)
  $('#how').onclick = howItWorks
  $('#sort').onchange = (e) => go(`/?tab=${tab}${e.target.value === 'date' ? '&sort=date' : ''}`, true)
  const p = await price()
  infinite($('#bounties'), (cursor) => q('bounties.fetchAll', { status: tab, sortType: sort, limit: 12, ...(cursor ? { cursor } : {}) }), (items) => items.map((b) => bountyCard(b, p)).join(''), tab === 'progress' ? 'no votes running right now' : 'no bounties here yet')
  q('claims.fetchLatest', { limit: 15 }).then((list) => {
    if (id !== renderId) return
    $('#latest').innerHTML = `<div class="strip">${list.map((c) => `<a class="tile" href="${bountyPath({ chainId: c.chainId, bountyId: c.bountyId })}" data-media data-src="${esc(c.claim.url)}" data-alt="${esc(c.claim.title)}"><div class="cap"><span class="ellipsis grow">${esc(c.bountyTitle)}</span><span data-who="${esc(lc(c.claim.issuer))}" data-only="av">${avatar(c.claim.issuer)}</span></div></a>`).join('')}</div>`
    hydrateMedia($('#latest'))
    hydratePeople($('#latest'))
  }).catch(() => ($('#latest').innerHTML = ''))
  q('claims.fetchRecentPayouts', { limit: 12 }).then((list) => {
    if (id !== renderId) return
    $('#payouts').innerHTML = `<div class="strip">${list.map((c) => `<a class="tile" href="${bountyPath({ chainId: c.chainId, bountyId: c.bountyId })}" data-media data-src="${esc(c.claim.url)}" data-alt="${esc(c.claim.title)}"><span class="pill white amt"><b>${fmtUsd(c.amountUsd)}</b></span><div class="cap"><span class="ellipsis grow">${esc(c.bountyTitle)}</span><span data-who="${esc(lc(c.claim.issuer))}" data-only="av">${avatar(c.claim.issuer)}</span></div></a>`).join('')}</div>`
    hydrateMedia($('#payouts'))
    hydratePeople($('#payouts'))
  }).catch(() => ($('#payouts').innerHTML = ''))
}

async function bountyPage(slug, dbId, params) {
  const chain = BY_SLUG[slug]
  if (!chain) return notFound()
  const chainId = chain.id
  const id = renderId
  app.innerHTML = `<div class="skel" style="height:44px;width:60%;margin:20px 0"></div><div class="skel" style="height:300px"></div>`
  const me = state.account
  // everything at once: the bounty plus the extras (cheap, the server caches them)
  const [b, parts, voting, mustVote, count, p] = await Promise.all([
    q('bounties.fetch', { id: dbId, chainId }).catch(() => null),
    q('bounties.participations', { bountyId: dbId, chainId }).catch(() => []),
    q('bounties.fetchVoting', { bountyId: dbId, chainId }).catch(() => null),
    me ? q('bounties.mustUseVoteFlow', { id: dbId, chainId }).catch(() => true) : false,
    q('bounties.claimsCount', { bountyId: dbId, chainId }).catch(() => 0),
    price(chain.currency || 'eth'),
  ])
  if (id !== renderId) return
  if (!b) return notFound('bounty not found')
  if (b.ban?.length) return notFound('this bounty was removed')
  document.title = `${b.title} | poidh`
  const isIssuer = me && me === lc(b.issuer)
  const mine = me && parts.find((x) => lc(x.userAddress) === me)
  const status = b.isCanceled ? 'cancelled' : !b.inProgress ? 'paid out' : b.isVoting ? 'voting' : 'open for claims'
  const eth = Number(BigInt(b.amount)) / 1e18
  app.innerHTML = `
    <a class="back" href="/">← all bounties</a>
    <div class="bounty">
      <header class="bhead">
        <h1>${esc(b.title)}</h1>
        <div class="row wrapflex muted" style="font-size:12px">${who(b.issuer)}<span>·</span><span>${ago(b.createdAt)}</span>${b.extra?.album ? `<span>·</span><a href="/a/${esc(encodeURIComponent(b.extra.album))}" class="pill">#${esc(b.extra.album)}</a>` : ''}</div>
      </header>
      <div class="bmain">
        <div class="panel"><div class="md" id="desc">${md(b.description)}</div><button class="btn sm hide more-btn" id="more">show more</button></div>
        <div id="vote"></div>
        <div class="sec"><h2>${count} claim${count === 1 ? '' : 's'}</h2>${b.inProgress && !chain.retired ? '<button class="btn sm red" id="claim2">submit a claim</button>' : ''}</div>
        <div class="claims" id="claims"></div>
        <div class="sec" id="comments-head"><h2>comments</h2></div>
        <form class="compose" id="compose"><textarea rows="2" maxlength="2000" placeholder="say something nice"></textarea><button class="btn red sm">post</button></form>
        <div class="comments" id="comments"><div class="skel" style="height:60px"></div></div>
      </div>
      <aside class="side">
        <div class="panel" style="display:flex;flex-direction:column;gap:12px">
          <div class="row between"><span class="pill ${b.inProgress ? 'red' : ''}">${status}</span><span class="row dim" style="font-size:12px">${chainDot(chainId)} ${chain.label}</span></div>
          <div><div class="big-amt">${fmtEth(b.amount)} ${unit(chainId)}</div><div class="muted">${p ? fmtUsd(eth * p) : ''}</div></div>
          <div id="actions" style="display:flex;flex-direction:column;gap:8px"></div>
          <dl class="kv">
            <dt>type</dt><dd>${b.isMultiplayer ? 'open bounty (anyone can add funds)' : 'solo bounty'}</dd>
            ${b.isMultiplayer ? `<dt>contributors</dt><dd>${parts.length}</dd>` : ''}
            ${mine ? `<dt>your stake</dt><dd>${fmtEth(mine.amount)} ${unit(chainId)}</dd>` : ''}
            <dt>bounty id</dt><dd><a href="${chain.explorer}/address/${chain.contract}" target="_blank" rel="noopener">#${b.onChainId}</a></dd>
          </dl>
          ${b.isMultiplayer && parts.length ? `<details class="fold"><summary>contributors</summary><ul>${parts.map((x) => `<li class="row between">${who(x.userAddress)}<span class="mono-nums">${fmtEth(x.amount)}</span></li>`).join('')}</ul></details>` : ''}
          <details class="fold" id="history"><summary>history</summary><ul><li class="dim">loading…</li></ul></details>
          <div class="row"><button class="btn sm grow" id="share">share</button><a class="btn sm grow" href="https://poidh.xyz${location.pathname}" target="_blank" rel="noopener">poidh.xyz ↗</a></div>
        </div>
      </aside>
    </div>`
  const desc = $('#desc')
  if (desc.scrollHeight > 420) {
    desc.classList.add('clamp')
    $('#more').classList.remove('hide')
    $('#more').onclick = (e) => { desc.classList.remove('clamp'); e.target.remove() }
  }
  hydratePeople()

  // actions
  const actions = []
  if (b.inProgress && !chain.retired) {
    actions.push(['submit a claim', 'red', () => claimForm(b)])
    if (b.isMultiplayer && !b.isVoting) actions.push(['add funds', '', () => joinForm(b, p)])
    if (mine && !isIssuer && !b.isVoting) actions.push(['withdraw my funds', '', (btn) => act(btn, async () => {
      await send(chainId, encode(SEL.withdrawFromOpenBounty, ['uint256'], [b.onChainId]), 0n, 'withdrawal')
      done('withdrawn. the funds are in your wallet.')
      reload()
    })])
    if (isIssuer && !b.isVoting) actions.push(['cancel bounty', '', (btn) => {
      confirmSheet('cancel this bounty?', b.isMultiplayer ? 'contributors can claim their refund on this page, and your share becomes withdrawable from your profile.' : 'your eth becomes withdrawable from your profile.', 'cancel bounty', () => act(btn, async () => {
        await send(chainId, encode(b.isMultiplayer ? SEL.cancelOpenBounty : SEL.cancelSoloBounty, ['uint256'], [b.onChainId]), 0n, 'cancellation')
        await poll(() => q('bounties.isCanceled', { chainId, id: dbId }, { fresh: true }), 20)
        done('bounty cancelled. withdraw your eth from your profile.')
        reload()
      }))
    }])
  }
  if (b.isCanceled && b.isMultiplayer && mine && !isIssuer) {
    const claimed = await q('accounts.hasClaimedRefund', { address: me, bountyId: dbId, chainId }).catch(() => true)
    if (!claimed) actions.push(['claim refund', 'red', (btn) => act(btn, async () => {
      await send(chainId, encode(SEL.claimRefundFromCancelledOpenBounty, ['uint256'], [b.onChainId]), 0n, 'refund')
      done('refund claimed. withdraw it from your profile.')
      reload()
    })])
  }
  $('#actions').innerHTML = actions.map(([l, c], i) => `<button class="btn block ${c}" data-a="${i}">${l}</button>`).join('') || (b.inProgress ? '' : '')
  $$('[data-a]').forEach((btn) => (btn.onclick = () => actions[btn.dataset.a][2](btn)))
  $('#claim2')?.addEventListener('click', () => claimForm(b))
  if (b.inProgress && !chain.retired) {
    app.insertAdjacentHTML('beforeend', `<div class="claimbar only-mobile"><div><b>${fmtEth(b.amount)} ${unit(chainId)}</b><span class="dim">${p ? fmtUsd(eth * p) : ''}</span></div><button class="btn red" id="claim3">submit a claim</button></div>`)
    $('#claim3').onclick = () => claimForm(b)
    // only once the panel's own button has scrolled away
    const bar = $('.claimbar')
    bar.hidden = true
    new IntersectionObserver(([e]) => (bar.hidden = e.isIntersecting || e.boundingClientRect.top > 0)).observe($('#actions'))
  }
  $('#share').onclick = () => share(b.title, location.origin + location.pathname)

  $('#history').addEventListener('toggle', async (e) => {
    if (!e.target.open || e.target.dataset.done) return
    e.target.dataset.done = 1
    const txs = await q('bounties.fetchTransactions', { bountyId: dbId, chainId }).catch(() => [])
    $('ul', e.target).innerHTML = txs.map((t) => `<li class="row between">${who(t.address)}<a class="dim" href="${chain.explorer}/tx/${esc(t.tx)}" target="_blank" rel="noopener">${esc(t.action)} · ${ago(Number(t.timestamp))}</a></li>`).join('') || '<li class="dim">nothing yet</li>'
    hydratePeople(e.target)
  })

  // voting
  if (b.isVoting && voting) renderVote(b, voting, parts)

  // claims
  const canPick = isIssuer && b.inProgress && !b.isVoting && !chain.retired
  infinite($('#claims'), (cursor) => q('claims.fetchBountyClaims', { bountyId: dbId, chainId, limit: 9, ...(cursor ? { cursor } : {}) }), async (items) => items.map((c) => claimCard(c, { canPick, mustVote, voting })).join(''), b.inProgress ? 'no claims yet. be the first!' : 'no claims')
  const pick = (c, vote, btn) => confirmSheet(vote ? 'submit this claim for a vote?' : 'accept this claim?', vote ? 'contributors get 48 hours to vote. if the vote passes, the claim wins the bounty.' : 'the bounty pays out to this claim. this cannot be undone.', vote ? 'start vote' : 'accept & pay', () => act(btn, async () => {
    await send(chainId, encode(vote ? SEL.submitClaimForVote : SEL.acceptClaim, ['uint256', 'uint256'], [b.onChainId, c.onChainId]), 0n, vote ? 'vote submission' : 'acceptance')
    done(vote ? 'voting started' : 'claim accepted, bounty paid out!')
    await poll(() => vote ? q('bounties.fetchVoting', { bountyId: dbId, chainId }, { fresh: true }).then((v) => v?.claimId === c.id && v) : q('claims.isAccepted', { chainId, id: c.id }, { fresh: true }), 20)
    reload()
  }))
  const open = (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter') return
    const btn = e.target.closest('[data-pick]')
    if (btn) return pick(claimsById.get(+btn.dataset.pick), btn.dataset.vote === '1', btn)
    const card = e.target.closest('[data-claim]')
    if (!card || e.target.closest('a')) return
    const c = claimsById.get(+card.dataset.claim)
    const d = sheet(`<div class="claim-view">
      <div class="big" data-media data-src="${esc(c.url)}" data-alt="${esc(c.title)}"></div>
      <div class="row between wrapflex"><h2>${esc(c.title)}</h2>${c.isAccepted ? '<span class="pill white"><b>winner</b></span>' : ''}</div>
      <div class="row wrapflex dim" style="font-size:12px">${who(c.issuer)}<span>·</span><span>claim #${c.onChainId}</span></div>
      ${c.description ? `<div class="md">${md(c.description)}</div>` : ''}
      ${canPick ? `<button class="btn red block" id="pick">${mustVote ? 'submit for vote' : 'accept this claim'}</button>` : ''}
    </div>`)
    hydrateMedia(d).then(() => {
      const fg = $('.fg', d)
      if (fg) fg.onclick = async () => lightbox((await resolveAll([c.url]))[0])
    })
    hydratePeople(d)
    $('#pick', d)?.addEventListener('click', (ev) => { d.close(); pick(c, mustVote, ev.currentTarget) })
  }
  $('#claims').addEventListener('click', open)
  $('#claims').addEventListener('keydown', open)

  loadComments(dbId, chainId, id)

  if (params.has('new')) share(b.title, location.origin + location.pathname, 'your bounty is live! share it so people can claim it.')
}
// --- comments: reading is public, posting and voting need a poidh session ------
async function loadComments(bountyId, chainId, id = renderId) {
  const list = await q('comments.fetch', { bountyId, chainId }).catch(() => null)
  if (id !== renderId) return
  if (!list) return ($('#comments').innerHTML = '<div class="dim">could not load comments</div>')
  for (const c of list) if (c.author) people.set(lc(c.userAddress), c.author)
  const kids = {}
  for (const c of list) (kids[c.parentId ?? 0] ||= []).push(c)
  const score = (c) => c.upvotes - c.downvotes
  const tree = (pid, depth) => (kids[pid] || []).sort((a, z) => score(z) - score(a) || new Date(a.createdAt) - new Date(z.createdAt)).map((c) => `
    <div class="comment" id="comment-${c.id}" style="margin-left:${Math.min(depth, 3) * 18}px">
      <div class="bubble"><div class="row between" style="font-size:11px"><span>${who(c.userAddress)}</span><span class="dim">${ago(c.createdAt)}</span></div><div class="md">${md(c.body)}</div>
        <div class="row cacts"><button data-rate="upvote" data-c="${c.id}">▲ ${c.upvotes || ''}</button><button data-rate="downvote" data-c="${c.id}">▼ ${c.downvotes || ''}</button><button data-reply="${c.id}">reply</button></div>
      </div>
    </div>${tree(c.id, depth + 1)}`).join('')
  const box = $('#comments')
  box.innerHTML = tree(0, 0) || '<div class="dim">no comments yet. start the conversation.</div>'
  hydratePeople(box)
  if (location.hash.startsWith('#comment-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' })
  const post = async (form, parentId) => {
    const text = $('textarea', form).value.trim()
    if (!text) return
    await act($('button', form), async () => {
      await authed(() => m('comments.comment', { bountyId, chainId, text, ...(parentId ? { parrentId: parentId } : {}) }))
      forget()
      loadComments(bountyId, chainId)
      form.reset()
    })
  }
  $('#compose').onsubmit = (e) => { e.preventDefault(); post(e.target) }
  box.onclick = (e) => {
    const r = e.target.closest('[data-rate]')
    if (r) return act(r, async () => { await authed(() => m('comments.rate', { chainId, commentId: +r.dataset.c, type: r.dataset.rate })); forget(); loadComments(bountyId, chainId) })
    const rep = e.target.closest('[data-reply]')
    if (!rep || rep.closest('.bubble').querySelector('form')) return
    rep.closest('.bubble').insertAdjacentHTML('beforeend', '<form class="compose"><textarea rows="2" maxlength="2000" placeholder="reply"></textarea><button class="btn red sm">reply</button></form>')
    const f = rep.closest('.bubble').querySelector('form')
    $('textarea', f).focus()
    f.onsubmit = (ev) => { ev.preventDefault(); post(f, +rep.dataset.reply) }
  }
}

// poidh's backend only accepts sign-in messages for poidh.xyz, so that's the domain the wallet sees
async function signIn() {
  await connect()
  const nonce = await m('auth.nonce')
  const now = new Date()
  const chainId = parseInt(await state.provider.request({ method: 'eth_chainId' }).catch(() => '0x2105'), 16) || 8453
  const message = `poidh.xyz wants you to sign in with your Ethereum account:\n${checksum(state.account)}\n\nSign in to poidh to comment and vote. This is free and does not send a transaction.\n\nURI: https://poidh.xyz\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${new Date(+now + 600_000).toISOString()}`
  toast('sign the message in your wallet (free, no transaction)')
  const hex = '0x' + [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const signature = await state.provider.request({ method: 'personal_sign', params: [hex, state.account] })
  await m('auth.signIn', { message, signature })
  state.session = state.account
}
// runs fn with a session for the connected wallet, signing in when there is none or it's someone else's
async function authed(fn) {
  await connect()
  if (state.session !== state.account) {
    const me = await q('auth.me', null, { fresh: true }).catch(() => null)
    if (lc(me?.address) === state.account) state.session = state.account
    else await signIn()
  }
  try {
    return await fn()
  } catch (e) {
    if (e.code !== 'UNAUTHORIZED') throw e
    await signIn()
    return fn()
  }
}

const reload = () => {
  forget()
  route()
}

const claimsById = new Map()
function claimCard(c, { canPick, mustVote, voting }) {
  const underVote = voting && voting.claimId === c.id
  claimsById.set(c.id, c)
  return `<div class="claim ${c.isAccepted ? 'win' : ''}" data-claim="${c.id}" tabindex="0" role="button" aria-label="${esc(c.title)}">
    <div class="media" data-media data-src="${esc(c.url)}" data-alt="${esc(c.title)}"></div>
    ${c.isAccepted ? '<span class="pill white ribbon"><b>winner</b></span>' : underVote ? '<span class="pill white ribbon"><b>under vote</b></span>' : ''}
    <div class="body">
      <h4>${esc(c.title)}</h4>
      <p>${esc(plain(c.description).slice(0, 220))}</p>
      <div class="meta">${who(c.issuer)}<span class="dim">#${c.onChainId}</span></div>
      ${canPick ? `<button class="btn sm white" data-pick="${c.id}" data-onchain="${c.onChainId}" data-vote="${mustVote ? 1 : 0}">${mustVote ? 'submit for vote' : 'accept'}</button>` : ''}
    </div>
  </div>`
}

async function renderVote(b, v, parts) {
  const chainId = b.chainId
  const total = parts.reduce((s, x) => s + Number(BigInt(x.amount)), 0) || 1
  const yes = Number(v.yes)
  const no = Number(v.no)
  const ended = b.deadline && b.deadline * 1000 <= Date.now()
  const me = state.account
  const canVote = me && !ended && parts.some((x) => lc(x.userAddress) === me) && (await q('accounts.canVote', { address: me, bountyId: b.id, chainId, currentRound: v.round ?? 1 }).catch(() => false))
  const claim = await q('claims.fetchVotingClaimByBountyId', { bountyId: b.id, chainId }).catch(() => null)
  $('#vote').innerHTML = `<div class="panel" style="margin-top:20px;display:flex;flex-direction:column;gap:10px">
    <div class="row between"><b>vote in progress${v.round > 1 ? ` · round ${v.round}` : ''}</b><span class="dim">${ended ? 'voting ended' : `ends ${b.deadline ? new Date(b.deadline * 1000).toLocaleString() : 'soon'}`}</span></div>
    ${claim ? `<div class="muted">claim under vote: <b>${esc(claim.title)}</b> by ${who(claim.issuer)}</div>` : ''}
    <div class="meter"><i style="width:${(yes / total) * 100}%"></i><i style="width:${(no / total) * 100}%"></i></div>
    <div class="row between" style="font-size:12px"><span>yes ${fmtEth(BigInt(Math.round(yes)))} (${Math.round((yes / total) * 100)}%)</span><span>no ${fmtEth(BigInt(Math.round(no)))} (${Math.round((no / total) * 100)}%)</span></div>
    <div class="row">${canVote ? '<button class="btn white grow" data-v="1">vote yes</button><button class="btn red grow" data-v="0">vote no</button>' : ''}${ended ? '<button class="btn white grow" id="resolve">resolve vote</button>' : ''}</div>
    <p class="dim" style="margin:0;font-size:11px">votes are weighted by contribution. more than 50% yes pays out the claim.</p>
  </div>`
  hydratePeople($('#vote'))
  $$('[data-v]').forEach((btn) => (btn.onclick = () => act(btn, async () => {
    await send(chainId, encode(SEL.voteClaim, ['uint256', 'bool'], [b.onChainId, btn.dataset.v === '1']), 0n, 'vote')
    done('vote cast')
    reload()
  })))
  $('#resolve')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
    await send(chainId, encode(SEL.resolveVote, ['uint256'], [b.onChainId]), 0n, 'resolution')
    done('vote resolved')
    reload()
  }))
}

function howItWorks() {
  const d = sheet(`<h2>how poidh works</h2>
    <ol class="steps">
      <li><b>post a bounty</b><span>describe what you want to see and lock eth in the poidh contract. solo bounties are yours to judge; open bounties let anyone add funds.</span></li>
      <li><b>people claim it</b><span>anyone can submit a pic or video as proof. every claim is minted as an nft.</span></li>
      <li><b>pick the winner</b><span>the issuer accepts the best claim and the eth goes to its creator. if others added funds, contributors vote for 48 hours, weighted by what they put in.</span></li>
      <li><b>withdraw</b><span>winnings and refunds wait in the contract until you withdraw them from your profile. poidh takes 2.5% of payouts.</span></li>
    </ol>
    <a class="btn red block" href="/create">create a bounty</a>`)
  $$('a', d).forEach((a) => a.addEventListener('click', () => d.close()))
}

function confirmSheet(title, text, yes, fn) {
  const d = sheet(`<h2>${esc(title)}</h2><p class="muted" style="margin:0">${esc(text)}</p><div class="row"><button class="btn grow" id="no">never mind</button><button class="btn red grow" id="yes">${esc(yes)}</button></div>`)
  $('#no', d).onclick = () => d.close()
  $('#yes', d).onclick = () => { d.close(); fn() }
}

function share(title, url, note = '') {
  const text = `${title} on poidh`
  const d = sheet(`<h2>share</h2>${note ? `<p class="muted" style="margin:0">${esc(note)}</p>` : ''}
    <input class="inp" readonly value="${esc(url)}">
    <div class="row wrapflex"><button class="btn grow" id="copy">copy link</button>
    <button class="btn grow" id="cast">farcaster</button>
    <a class="btn grow" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}">x</a>
    ${navigator.share ? '<button class="btn grow" id="native">more</button>' : ''}</div>`)
  $('#copy', d).onclick = () => navigator.clipboard.writeText(url).then(() => done('link copied'))
  $('#cast', d).onclick = () => (state.mini ? state.mini.composeCast({ text, embeds: [url] }) : window.open(`https://farcaster.xyz/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(url)}`, '_blank'))
  $('#native', d)?.addEventListener('click', () => navigator.share({ title: text, url }).catch(() => {}))
}

// --- forms -------------------------------------------------------------------
function amountField(p, min = '0.001') {
  return `<label class="field">amount (eth)<input class="inp" id="amt" inputmode="decimal" placeholder="${min}" autocomplete="off"></label><div class="dim" id="amtusd" style="font-size:12px;margin-top:-8px">min ${min} eth${p ? ` · ${fmtUsd(+min * p)}` : ''}</div>`
}
function bindAmount(d, p) {
  $('#amt', d).oninput = (e) => {
    const v = parseFloat(e.target.value.replace(',', '.'))
    $('#amtusd', d).textContent = v > 0 && p ? `≈ ${fmtUsd(v * p)}` : 'min 0.001 eth'
  }
}
const readAmount = (d) => {
  const wei = parseEth($('#amt', d).value.replace(',', '.'))
  if (wei < 10n ** 15n) throw new Error('the minimum is 0.001 eth')
  return wei
}

function joinForm(b, p) {
  const d = sheet(`<h2>add funds</h2><p class="muted" style="margin:0">your eth joins the pot. contributors vote on the winning claim, and you can withdraw while no vote is running.</p>${amountField(p)}<button class="btn red block" id="go">add funds</button>`)
  bindAmount(d, p)
  $('#go', d).onclick = (e) => act(e.currentTarget, async () => {
    const wei = readAmount(d)
    await send(b.chainId, encode(SEL.joinOpenBounty, ['uint256'], [b.onChainId]), wei, 'contribution')
    d.close()
    done('you joined the bounty!')
    await poll(() => q('bounties.isJoined', { bountyId: b.id, chainId: b.chainId, participantAddress: state.account }, { fresh: true }), 20)
    reload()
  })
}

async function compress(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 300_000) return file
  try {
    const img = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) })
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

function claimForm(b) {
  const d = sheet(`<h2>submit a claim</h2>
    <p class="muted" style="margin:0">show proof you did it. pics or it didn't happen.</p>
    <label class="drop" id="drop"><input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime" hidden><span>tap to add a photo or video</span></label>
    <label class="field">title<input class="inp" id="t" maxlength="100" placeholder="what did you do?"></label>
    <label class="field">description<textarea id="ds" rows="4" maxlength="5000" placeholder="details, links, context"></textarea></label>
    <button class="btn red block" id="go">submit claim</button>
    <p class="dim" style="margin:0;font-size:11px">your claim is minted as an nft. it moves to the bounty issuer if your claim wins.</p>`)
  let file = null
  let preview = null
  const input = $('input[type=file]', d)
  const pick = async (f) => {
    if (!f) return
    if (f.size > 50 * 1024 * 1024) return toast('max file size is 50 mb', true)
    file = await compress(f)
    if (preview) URL.revokeObjectURL(preview)
    preview = URL.createObjectURL(file)
    $('#drop span', d).outerHTML = f.type.startsWith('video') ? `<video src="${preview}" muted autoplay loop playsinline style="max-height:260px;border-radius:10px"></video>` : `<img src="${preview}" alt="">`
  }
  input.onchange = () => pick(input.files[0])
  const drop = $('#drop', d)
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]) }
  $('#go', d).onclick = (e) => act(e.currentTarget, async () => {
    const title = $('#t', d).value.trim()
    const description = $('#ds', d).value.trim()
    if (!file) throw new Error('add a photo or video first')
    if (!title) throw new Error('give your claim a title')
    await connect()
    toast('uploading…')
    const up = await fetch('/upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
    if (!up.ok) throw new Error((await up.text()) || 'upload failed')
    const { url } = await up.json()
    const receipt = await send(b.chainId, encode(SEL.createClaim, ['uint256', 'string', 'string', 'string'], [b.onChainId, title, description, url]), 0n, 'claim')
    d.close()
    done('claim submitted!')
    const hash = lc(receipt.transactionHash)
    await poll(() => q('bounties.fetchTransactions', { bountyId: b.id, chainId: b.chainId }, { fresh: true }).then((t) => t.some((x) => lc(x.tx) === hash)), 30)
    reload()
  })
}

async function create() {
  const p = await price()
  app.innerHTML = `<a class="back" href="/">← all bounties</a>
  <div class="form">
    <div><h1 class="page-title">create a bounty</h1><p class="lead" style="margin:0">describe what you want to see. put up eth. the best pic wins.</p></div>
    <label class="field">title<input class="inp" id="t" maxlength="100" placeholder="e.g. take a pic of a cat wearing a tiny hat"></label>
    <label class="field">description<textarea id="ds" rows="8" placeholder="what counts as proof? any rules or deadline? markdown works."></textarea></label>
    <div class="field">type<div class="seg" id="type"><button class="on" data-v="solo">solo · you pick the winner</button><button data-v="open">open · others can add funds</button></div></div>
    <div class="field">network<div class="seg" id="net">${LIVE.map((id, i) => `<button class="${i ? '' : 'on'}" data-v="${id}">${CHAINS[id].label}</button>`).join('')}</div></div>
    ${amountField(p)}
    <label class="field">album (optional)<input class="inp" id="al" maxlength="40" placeholder="e.g. art, research, halloween"></label>
    <button class="btn red block" id="go">create bounty</button>
    <p class="dim" style="font-size:11px;margin:0">the eth sits in the poidh contract until you accept a claim or cancel. poidh takes a 2.5% fee on payout. open bounties with outside contributors pick winners by a 48 hour vote.</p>
  </div>`
  for (const seg of $$('.seg', app)) seg.onclick = (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === btn))
  }
  bindAmount(app, p)
  $('#go').onclick = (e) => act(e.currentTarget, async () => {
    const title = $('#t').value.trim()
    const description = $('#ds').value.trim()
    if (!title) throw new Error('give your bounty a title')
    if (!description) throw new Error('describe what counts as proof')
    const wei = readAmount(app)
    const open = $('#type .on').dataset.v === 'open'
    const chainId = +$('#net .on').dataset.v
    const receipt = await send(chainId, encode(open ? SEL.createOpenBounty : SEL.createSoloBounty, ['string', 'string'], [title, description]), wei, 'bounty')
    const log = receipt.logs.find((l) => l.topics?.[0] === BOUNTY_CREATED && lc(l.address) === lc(CHAINS[chainId].contract))
    const onChainId = log ? Number(BigInt(log.topics[1])) : null
    done('bounty created! indexing…')
    const row = onChainId != null && (await poll(() => q('bounties.isNewlyCreated', { chainId, id: onChainId }, { fresh: true })))
    if (!row) return go('/')
    const album = $('#al').value.trim().toLowerCase()
    if (album) await m('bounties.addToAlbum', { bountyId: row.id, chainId, album }).catch(() => {})
    go(`/${CHAINS[chainId].slug}/bounty/${row.id}?new=1`)
  })
}

async function account(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return notFound()
  addr = lc(addr)
  const id = renderId
  const own = state.account === addr
  app.innerHTML = `<div class="profile">${avatar(addr, 'av lg')}<div class="grow" style="min-width:0"><h1 id="pname">${esc(nameOf(addr))}</h1><div class="row dim wrapflex" style="font-size:12px"><span>${short(addr)}</span><button class="btn sm" id="copy">copy</button><span id="socials" class="row"></span></div><div id="zk" style="margin-top:8px"></div></div></div>
    <div class="statgrid" id="stats">${'<div class="stat skel" style="height:64px"></div>'.repeat(4)}</div>
    <div id="mine"></div>
    <div class="toolbar"><div class="tabs" id="tabs"><button class="on" data-t="bounties">bounties</button><button data-t="claims">claims</button><button data-t="nfts">collected</button></div></div>
    <div id="list"></div>`
  $('#copy').onclick = () => navigator.clipboard.writeText(addr).then(() => done('address copied'))
  Promise.all([q('neynar.usersData', { addresses: [addr] }).catch(() => []), q('web3.fetchHumanReadableName', { address: addr }).catch(() => null)]).then(([u, n]) => {
    if (u?.[0]) people.set(addr, u[0])
    if (n) names.set(addr, n)
    if (id !== renderId) return
    $('#pname').textContent = nameOf(addr)
    $('.profile .av').outerHTML = avatar(addr, 'av lg')
    const x = u?.[0]
    $('#socials').innerHTML = [x?.farcasterTag && `<a href="https://farcaster.xyz/${esc(x.farcasterTag)}" target="_blank" rel="noopener">farcaster</a>`, x?.twitterTag && `<a href="https://x.com/${esc(x.twitterTag)}" target="_blank" rel="noopener">x</a>`].filter(Boolean).join(' · ')
    document.title = `${nameOf(addr)} | poidh`
  })
  Promise.all([q('accounts.stats', { address: addr }), q('accounts.activitiesCount', { address: addr })]).then(([s, c]) => {
    if (id !== renderId) return
    $('#stats').innerHTML = [
      [Number(s.poidhScore).toLocaleString(), 'poidh score'],
      [fmtUsd(s.eth.totalEarn.amountUSD), `earned · ${fmtEth(BigInt(Math.round(s.eth.totalEarn.amountCrypto * 1e18)), 3)} eth`],
      [fmtUsd(s.eth.totalPaid.amountUSD), `paid out · ${fmtEth(BigInt(Math.round(s.eth.totalPaid.amountCrypto * 1e18)), 3)} eth`],
      [fmtUsd(s.eth.amountInContract.amountUSD), 'in open bounties'],
      [c.bounties, `bounties · ${c.activeBounties} active`],
      [c.claims, `claims · ${c.completedClaims} won`],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')
  }).catch(() => ($('#stats').innerHTML = ''))
  if (own) ownerBox(addr)
  passportBadge(addr, own)
  const tabs = {
    bounties: [(cursor) => q('accounts.bounties', { address: addr, limit: 12, ...(cursor ? { cursor } : {}) }), async (items) => { const p = await price(); return items.map((b) => bountyCard(b, p)).join('') }, 'grid'],
    claims: [(cursor) => q('accounts.claims', { address: addr, limit: 12, ...(cursor ? { cursor } : {}) }), async (items) => items.map(claimLink).join(''), 'claims'],
    nfts: [(cursor) => q('accounts.nfts', { address: addr, limit: 12, ...(cursor ? { cursor } : {}) }), async (items) => items.map(claimLink).join(''), 'claims'],
  }
  const show = (t) => {
    renderId++
    $('.more', app)?.remove()
    $('#list').innerHTML = `<div class="${tabs[t][2]}"></div>`
    infinite($('#list').firstChild, tabs[t][0], tabs[t][1])
  }
  $('#tabs').onclick = (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === btn))
    show(btn.dataset.t)
  }
  infinite($('#list').appendChild(Object.assign(document.createElement('div'), { className: 'grid' })), tabs.bounties[0], tabs.bounties[1])
}
const claimLink = (c) => `<a class="claim" href="${bountyPath({ chainId: c.chainId, bountyId: c.bountyId })}" style="text-decoration:none">
  <div class="media" data-media data-src="${esc(c.url)}" data-alt="${esc(c.title)}" style="cursor:pointer"></div>
  ${c.isAccepted ? '<span class="pill white ribbon"><b>winner</b></span>' : ''}
  <div class="body"><h4>${esc(c.title)}</h4><p>${esc(plain(c.description).slice(0, 160))}</p><div class="meta">${chainDot(c.chainId)}<span class="dim">#${c.onChainId}</span></div></div></a>`

// --- zkpassport: a nationality badge proven with zero knowledge -----------------
async function passportBadge(addr, own) {
  const st = await q('zkpassport.status', { address: addr }).catch(() => null)
  const box = $('#zk')
  if (!box) return
  if (st?.verified) box.innerHTML = `<span class="pill white" title="nationality proven with zkpassport"><b>✓ passport verified</b>${st.country ? ` · ${esc(st.country)}` : ''}</span>`
  else if (own) {
    box.innerHTML = '<button class="btn sm" id="zkgo">verify your passport</button>'
    $('#zkgo').onclick = (e) => act(e.currentTarget, () => verifyPassport(addr))
    // the sdk takes a second to load and start, so begin on hover / touch
    for (const ev of ['pointerenter', 'touchstart']) $('#zkgo').addEventListener(ev, () => import('./vendor/zkpassport.js?v=__V__'), { once: true, passive: true })
  }
}
async function verifyPassport(addr) {
  await authed(async () => {})
  const { ZKPassport, qrcode } = await import('./vendor/zkpassport.js?v=__V__')
  // proofs are bound to a domain; poidh's backend checks them against poidh.xyz
  const zk = new ZKPassport('poidh.xyz')
  const req = await zk.request({ name: 'poidh', logo: location.origin + '/icon.png', purpose: 'verify your nationality for your poidh profile badge', scope: 'poidh-profile-verification' })
  const { url, requestId, onRequestReceived, onGeneratingProof, onSuccess, onReject, onError } = req.disclose('nationality').bind('user_address', addr).done()
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  const d = sheet(`<h2>verify your passport</h2>
    <p class="muted" style="margin:0">scan this with the zkpassport app. it proves your nationality with zero knowledge: nothing else from your passport leaves your phone. the app shows poidh.xyz as the requester, since poidh's backend checks the proof.</p>
    <div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
    <a class="btn white block" href="${esc(url)}">open zkpassport on this phone</a>
    <p class="dim" id="zkst" style="margin:0;text-align:center">waiting for the app…</p>`)
  let finished = false
  d.addEventListener('close', () => !finished && zk.cancelRequest?.(requestId))
  const status = (t) => $('#zkst', d) && ($('#zkst', d).textContent = t)
  onRequestReceived(() => status('request received, follow the steps in the app…'))
  onGeneratingProof(() => status('generating the proof on your phone…'))
  onReject(() => { status('cancelled in the app'); finished = true })
  onError((e) => { toast(String(e?.message || e), true); finished = true; d.close() })
  onSuccess(async ({ proofs, result }) => {
    status('checking the proof…')
    try {
      await authed(() => m('zkpassport.verify', { proofs, queryResult: result }))
      finished = true
      d.close()
      done('passport verified!')
      forget()
      passportBadge(addr, true)
    } catch (e) {
      toast(e.code === 'CONFLICT' ? 'this passport is already linked to another wallet' : e.message, true)
      finished = true
      d.close()
    }
  })
}

async function ownerBox(addr) {
  const id = renderId
  const balances = await Promise.all(LIVE.map(async (cid) => {
    const r = await rpc(CHAINS[cid].rpc, 'eth_call', [{ to: CHAINS[cid].contract, data: encode(SEL.pendingWithdrawals, ['address'], [addr]) }, 'latest']).catch(() => '0x0')
    return [cid, BigInt(r === '0x' ? 0 : r)]
  }))
  const refunds = await q('accounts.pendingRefunds', { address: addr }).catch(() => [])
  if (id !== renderId) return
  const due = balances.filter(([, v]) => v > 0n)
  if (!due.length && !refunds.length) return
  $('#mine').innerHTML = `<div class="panel" style="margin-top:16px;display:flex;flex-direction:column;gap:10px">
    ${due.map(([cid, v]) => `<div class="row between wrapflex"><span>you have <b>${fmtEth(v)} eth</b> to withdraw on ${CHAINS[cid].label}</span><button class="btn red sm" data-w="${cid}">withdraw</button></div>`).join('')}
    ${refunds.map((r) => `<div class="row between wrapflex"><span>refund available from <a href="/${chainOf(r.chainId).slug}/bounty/${r.bountyId}">${esc(r.title)}</a></span><a class="btn sm" href="/${chainOf(r.chainId).slug}/bounty/${r.bountyId}">claim</a></div>`).join('')}
  </div>`
  $$('[data-w]').forEach((btn) => (btn.onclick = () => act(btn, async () => {
    await send(+btn.dataset.w, SEL.withdraw, 0n, 'withdrawal')
    done('withdrawn to your wallet')
    route()
  })))
}

async function leaderboard(params) {
  const page = Math.max(1, +params.get('page') || 1)
  app.innerHTML = `<h1 class="page-title">leaderboard</h1><p class="lead">the top 100 on poidh. score = eth earned and paid out × 1000, plus 10 per claim collected.</p>
    <div id="me"></div><div id="podium"></div><div class="lb-list" id="lb">${'<div class="skel" style="height:64px"></div>'.repeat(page === 1 ? 7 : 10)}</div><div id="pages"></div>`
  if (page === 1) $('#podium').innerHTML = `<div class="podium">${'<div class="skel" style="height:220px"></div>'.repeat(3)}</div>`
  const [r, top] = await Promise.all([
    q('leaderboard.fetch', { page, limit: 10, ...(state.account ? { userAddress: state.account } : {}) }).catch(() => null),
    page === 1 ? null : q('leaderboard.fetch', { page: 1, limit: 10 }).catch(() => null),
  ])
  if (!r) return ($('#lb').innerHTML = '<div class="empty">could not load the leaderboard</div>')
  const best = (top || r).leaderboard[0]?.[1].total || 1
  const chains = (s) => [['base', s.base], ['arbitrum', s.arbitrum], ['ethereum', s.mainnet], ['degen', s.degen]].filter(([, v]) => v > 0)
    .map(([c, v]) => `<span title="${c}">${chainDot(BY_SLUG[c === 'ethereum' ? 'mainnet' : c].id)} ${v.toLocaleString()}</span>`).join('')
  const row = (rank, [a, s], me = false) => `<a class="lb-row${me ? ' me' : ''}" href="/account/${esc(lc(a))}" style="--w:${Math.max(2, (s.total / best) * 100)}%">
    <span class="rank">${rank}</span><span data-who="${esc(lc(a))}" data-only="av">${avatar(a)}</span>
    <span class="grow"><span class="nm ellipsis" data-name="${esc(lc(a))}">${esc(nameOf(a))}</span><span class="chains">${chains(s)}</span></span>
    <span class="score">${s.total.toLocaleString()}</span></a>`
  const list = r.leaderboard.map((x, i) => [(page - 1) * 10 + i + 1, x])
  if (page === 1) {
    const medal = ['🥇', '🥈', '🥉']
    $('#podium').innerHTML = `<div class="podium">${list.slice(0, 3).map(([rank, [a, s]], i) => `
      <a class="step s${rank}" href="/account/${esc(lc(a))}">
        <span class="medal">${medal[i]}</span><span data-who="${esc(lc(a))}" data-only="av" data-cls="av xl">${avatar(a, 'av xl')}</span>
        <b class="ellipsis" data-name="${esc(lc(a))}">${esc(nameOf(a))}</b><span class="score">${s.total.toLocaleString()}</span><span class="chains">${chains(s)}</span>
      </a>`).join('')}</div>`
  }
  $('#lb').innerHTML = list.slice(page === 1 ? 3 : 0).map(([rank, x]) => row(rank, x, lc(x[0]) === state.account)).join('')
  if (r.userData && !list.some(([, x]) => lc(x[0]) === state.account)) $('#me').innerHTML = `<div class="sec" style="margin-top:0"><h2>you</h2></div>${row(r.userData.rank, r.userData.data, true)}`
  const n = r.pagination.totalPages
  $('#pages').innerHTML = `<nav class="pages">${page > 1 ? `<a class="btn sm" href="?page=${page - 1}" aria-label="previous page">←</a>` : ''}${Array.from({ length: n }, (_, i) => `<a class="btn sm${i + 1 === page ? ' on' : ''}" href="?page=${i + 1}">${i + 1}</a>`).join('')}${page < n ? `<a class="btn sm" href="?page=${page + 1}" aria-label="next page">→</a>` : ''}</nav>`
  hydratePeople(app)
}

async function album(name, params) {
  name = decodeURIComponent(name).toLowerCase()
  const tab = ['open', 'progress', 'past'].includes(params.get('tab')) ? params.get('tab') : 'open'
  app.innerHTML = `<a class="back" href="/">← all bounties</a><h1 class="page-title">#${esc(name)}</h1>
    <div class="toolbar"><div class="tabs" id="tabs"></div></div><div class="grid" id="bounties"></div>`
  q('bounties.fetchAlbumCounts', { album: name }).then((c) => {
    $('#tabs').innerHTML = [['open', 'open'], ['progress', 'voting'], ['past', 'past']].map(([k, l]) => `<a href="?tab=${k}" class="${tab === k ? 'on' : ''}">${l} ${c[k] ?? ''}</a>`).join('')
  }).catch(() => {})
  const p = await price()
  infinite($('#bounties'), (cursor) => q('bounties.fetchByAlbum', { album: name, status: tab, limit: 12, ...(cursor ? { cursor } : {}) }), (items) => items.map((b) => bountyCard(b, p)).join(''))
}

async function explore(params) {
  const s = (params.get('search') || '').trim()
  app.innerHTML = `<h1 class="page-title" style="margin-bottom:20px">${s ? `results for “${esc(s)}”` : 'explore'}</h1><div id="users"></div><div class="grid" id="bounties"></div>`
  const p = await price()
  if (s) q('users.fetchByKeyword', { search: s, limit: 8 }).then((r) => {
    if (!r.items.length) return
    $('#users').innerHTML = `<div class="row wrapflex" style="margin-bottom:18px">${r.items.map((u) => `<a class="pill" href="/account/${esc(lc(u.address))}">${esc(u.farcaster_tag || u.ens || u.gwei || u.wei || u.degen_name || short(u.address))}</a>`).join('')}</div>`
  }).catch(() => {})
  infinite($('#bounties'), (cursor) => q('bounties.fetchByKeyword', { keyword: s, limit: 12, ...(cursor ? { cursor } : {}) }), (items) => items.map((b) => bountyCard(b, p)).join(''), 'no bounties match that')
}

async function feed(params) {
  const tab = params.get('tab') === 'you' && state.account ? 'you' : 'all'
  app.innerHTML = `<h1 class="page-title">activity</h1><p class="lead">bounties, claims, payouts, votes and comments as they happen.</p>
    <div class="toolbar" style="margin-top:0"><div class="tabs"><a href="/feed" class="${tab === 'all' ? 'on' : ''}">everyone</a>${state.account ? `<a href="/feed?tab=you" class="${tab === 'you' ? 'on' : ''}">you</a>` : ''}</div></div>
    <div class="feed" id="feed"></div>`
  const p = await price()
  infinite($('#feed'), (cursor) => q('accounts.activities', { limit: 20, ...(tab === 'you' ? { address: state.account } : {}), ...(cursor ? { cursor } : {}) }), async (items) => items.map((a) => activityRow(a, p)).join(''), tab === 'you' ? 'nothing yet. create a bounty or submit a claim!' : 'no activity')
}
function activityRow(a, p) {
  const b = a.bounty
  const href = b ? bountyPath(b) + (a.comment ? `#comment-${a.comment.id}` : '') : '#'
  const title = b ? `<b>${esc(b.title)}</b>` : 'a bounty'
  const act = a.action || ''
  const money = (eth) => `${eth} ${unit(a.chainId)}${p && unit(a.chainId) === 'eth' ? ` (${fmtUsd(+eth * p)})` : ''}`
  const text =
    act === 'bounty created' ? `created ${title}${b ? ` for ${money(fmtEth(b.amount))}` : ''}`
      : act === 'claim created' ? `claimed ${title}`
        : act === 'claim accepted' ? `accepted a claim on ${title} 🏆`
          : /^[+-]/.test(act) ? `${act[0] === '+' ? 'added' : 'withdrew'} ${money(act.slice(1).replace(/\s*eth$/, '').trim())} ${act[0] === '+' ? 'to' : 'from'} ${title}`
            : act.includes('submitted for vote') ? `nominated a claim on ${title} for a vote`
              : act === 'voted' ? `voted on ${title}`
                : act === 'voting resolved' ? `resolved the vote on ${title}`
                  : act === 'bounty canceled' ? `cancelled ${title}`
                    : act === 'comment created' ? `commented on ${title}`
                      : act === 'reply created' ? `replied on ${title}`
                        : `${esc(act)} · ${title}`
  return `<a class="act" href="${href}">
    <span data-who="${esc(lc(a.address))}" data-only="av">${avatar(a.address)}</span>
    <div class="grow"><div><span class="nm" data-name="${esc(lc(a.address))}">${esc(nameOf(a.address))}</span> ${text}</div>
      ${a.comment?.body ? `<div class="quote">${esc(plain(a.comment.body).slice(0, 240))}</div>` : ''}
      <div class="dim" style="font-size:11px">${ago(Number(a.timestamp))} · ${chainOf(a.chainId).label}</div></div>
    ${a.claim?.url ? `<div class="thumb" data-media data-src="${esc(a.claim.url)}" data-alt=""></div>` : ''}
  </a>`
}

function notFound(msg = 'page not found') {
  app.innerHTML = `<div class="empty"><h1 class="page-title">${esc(msg)}</h1><p><a href="/">back to bounties</a></p></div>`
}

// --- search box ----------------------------------------------------------------
const box = $('#search')
const input = $('input', box)
const suggest = $('.suggest', box)
let st
input.oninput = () => {
  clearTimeout(st)
  const s = input.value.trim()
  if (s.length < 2) return suggest.classList.add('hide')
  st = setTimeout(async () => {
    const [b, u] = await Promise.all([q('bounties.fetchByKeyword', { keyword: s, limit: 6 }).catch(() => ({ items: [] })), q('users.fetchByKeyword', { search: s, limit: 4 }).catch(() => ({ items: [] }))])
    if (input.value.trim() !== s) return
    suggest.innerHTML = (b.items.length ? '<div class="lbl">bounties</div>' + b.items.map((x) => `<a href="${bountyPath(x)}">${chainDot(x.chainId)}<span class="ellipsis grow">${esc(x.title)}</span><span class="dim">${fmtEth(x.amount, 3)}</span></a>`).join('') : '') +
      (u.items.length ? '<div class="lbl">people</div>' + u.items.map((x) => `<a href="/account/${esc(lc(x.address))}"><i class="av" style="background:${grad(x.address)}"></i><span class="ellipsis">${esc(x.farcaster_tag || x.ens || x.gwei || x.wei || short(x.address))}</span></a>`).join('') : '') ||
      '<div class="lbl">nothing found</div>'
    suggest.classList.remove('hide')
  }, 220)
}
input.onkeydown = (e) => {
  if (e.key === 'Enter' && input.value.trim()) { suggest.classList.add('hide'); go('/explore?search=' + encodeURIComponent(input.value.trim())) }
  if (e.key === 'Escape') suggest.classList.add('hide')
}
document.addEventListener('click', (e) => !box.contains(e.target) && suggest.classList.add('hide'))
$('#search-toggle').onclick = () => { box.classList.toggle('closed'); $$('.logo, .nav').forEach((x) => x.classList.toggle('hide', !box.classList.contains('closed'))); input.focus() }

// --- theme, connect --------------------------------------------------------------
const themeLabel = () => ($('#theme2').textContent = document.documentElement.dataset.theme === 'dark' ? 'light mode' : 'dark mode')
$('#theme').onclick = $('#theme2').onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark'
  document.documentElement.dataset.theme = dark ? 'light' : 'dark'
  try { localStorage.setItem('theme', document.documentElement.dataset.theme) } catch {}
  themeLabel()
}
themeLabel()
const soundLabel = () => ($('#sound').textContent = `sound: ${soundOn() ? 'on' : 'off'}`)
$('#sound').onclick = () => { setSound(!soundOn()); soundLabel(); sfx.tap() }
soundLabel()
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#sound')) return
  if (e.target.closest('button:not(:disabled), a.btn, .tabs a, .card, .tile, .claim, .act, .nav a, .suggest a, summary')) sfx.tap()
})
// warm the next page's data on hover / touch so it opens instantly
const warmed = new Set()
function warm(e) {
  const a = e.target.closest?.('a[href]')
  if (!a || warmed.has(a.href)) return
  const u = new URL(a.href)
  if (u.origin !== location.origin) return
  warmed.add(a.href)
  let m
  if ((m = u.pathname.match(/^\/(mainnet|arbitrum|base|degen)\/bounty\/(\d+)$/))) {
    const chainId = BY_SLUG[m[1]].id
    const id = +m[2]
    q('bounties.fetch', { id, chainId }).catch(() => {})
    q('bounties.participations', { bountyId: id, chainId }).catch(() => {})
    q('bounties.claimsCount', { bountyId: id, chainId }).catch(() => {})
    q('bounties.fetchVoting', { bountyId: id, chainId }).catch(() => {})
    q('claims.fetchBountyClaims', { bountyId: id, chainId, limit: 9 }).then((r) => resolveAll(r.items.map((c) => c.url))).catch(() => {})
    q('comments.fetch', { bountyId: id, chainId }).catch(() => {})
  } else if ((m = u.pathname.match(/^\/account\/(0x[0-9a-f]{40})$/i))) {
    const address = m[1].toLowerCase()
    q('accounts.stats', { address }).catch(() => {})
    q('accounts.activitiesCount', { address }).catch(() => {})
    q('accounts.bounties', { address, limit: 12 }).catch(() => {})
  }
}
document.addEventListener('pointerover', warm, { passive: true })
document.addEventListener('touchstart', warm, { passive: true })
$('#connect').onclick = () => (state.account ? accountMenu() : connect().catch(() => {}))

// --- router --------------------------------------------------------------------
let depth = 0
function go(url, replace = false) {
  if (!replace) depth++
  history[replace ? 'replaceState' : 'pushState'](null, '', url)
  route()
  scrollTo(0, 0)
}
async function route(params) {
  renderId++
  $$('.more').forEach((x) => x.remove())
  const path = location.pathname.replace(/\/+$/, '') || '/'
  params ||= new URLSearchParams(location.search)
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', (a.dataset.nav === 'home' && path === '/') || path === '/' + a.dataset.nav || (a.dataset.nav === 'me' && !!state.account && path === '/account/' + state.account)))
  $('.create-btn').classList.toggle('hide', path === '/create')
  state.mini?.setBack(depth > 0)
  let m
  try {
    if (path === '/') {
      document.title = "poidh - pics or it didn't happen"
      return await home(params)
    }
    if ((m = path.match(/^\/(mainnet|arbitrum|base|degen)\/bounty\/(\d+)$/))) return await bountyPage(m[1], +m[2], params)
    if ((m = path.match(/^\/account\/([^/]+)$/))) return await account(m[1])
    if ((m = path.match(/^\/a\/([^/]+)$/))) return await album(m[1], params)
    if (path === '/create') return await create()
    if (path === '/me') {
      if (!state.account) await connect().catch(() => {})
      if (state.account) return go('/account/' + state.account, true)
      app.innerHTML = `<div class="empty"><h1 class="page-title">your profile</h1><p>connect a wallet to see your bounties, claims and winnings.</p><button class="btn white" id="c2">connect</button></div>`
      return ($('#c2').onclick = () => connect().then(() => go('/account/' + state.account, true), () => {}))
    }
    if (path === '/leaderboard') return await leaderboard(params)
    if (path === '/explore') return await explore(params)
    if (path === '/feed') return await feed(params)
    notFound()
  } catch (e) {
    console.error(e)
    app.innerHTML = `<div class="empty">something broke: ${esc(e.message)}<p><button class="btn" onclick="location.reload()">reload</button></p></div>`
  }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a')
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const url = new URL(a.href, location.href)
  if (a.target === '_blank' || url.origin !== location.origin) {
    if (state.mini && /^https?:/.test(url.href)) { e.preventDefault(); state.mini.openUrl(url.href) }
    return
  }
  if (url.pathname.startsWith('/api/') || a.hasAttribute('download')) return
  e.preventDefault()
  $$('dialog[open]').forEach((d) => d.close())
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return location.hash = url.hash
  go(url.pathname + url.search + url.hash)
})
addEventListener('popstate', () => ((depth = Math.max(0, depth - 1)), route()))

// --- boot ----------------------------------------------------------------------
const framed = window.ReactNativeWebView || window !== window.parent
if (framed) {
  const mini = await import('./miniapp.js?v=__V__')
  const ctx = await mini.detect()
  if (ctx) {
    state.mini = mini
    document.documentElement.classList.add('mini')
    useProvider(mini.provider, 'farcaster')
    mini.events.addEventListener('back_navigation_triggered', () => history.back())
    mini.provider.request({ method: 'eth_accounts' }).then((a) => a?.[0] && setAccount(a[0])).catch(() => {})
  }
}
if (!state.mini) autoConnect().then(() => state.account && route())
await route()
state.mini?.ready()
