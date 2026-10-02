/**
 * mobile-console — self-check.
 *
 * `node tools/verify.mjs` runs every assertion and exits non-zero on the first
 * class of defect. The plugin is small but it owns two things that are easy to
 * get wrong and expensive to notice: a LAN listener, and a QR symbol. So the
 * checks are behavioural wherever behaviour exists —
 *
 *   1. manifest / bundle shape (what `install_bundle` reads)
 *   2. patch layer (one insert; no override of another bundle's row)
 *   3. control routes on a fake Host: authenticated vs not, and the fact that
 *      the unauthenticated answer must not carry the launch token
 *   4. the bridge itself, end to end: a real upstream HTTP server, a real
 *      proxied GET (proving Host/Origin rewriting), a real WebSocket upgrade
 *      (proving the socket path), and a real close
 *   5. the browser half's registration shape: seed-only requires, no Remote,
 *      no shell takeover
 *   6. the inlined QR encoder, compared against `plugin/qr.js` payload for
 *      payload
 *   7. the encoder's structure, on both copies
 *   8. readability, through jsQR — an independent decoder
 *   9. the stylesheet: theme tokens only, no literal colours
 *
 * Section 8 needs `pnpm install` (jsQR); every other section has no dependency
 * beyond Node itself.
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'

const PLUGIN = new URL('../plugin/', import.meta.url)
const read = name => readFileSync(new URL(name, PLUGIN), 'utf8')

let passed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/* ================================================================== *
 * 1. Manifest
 * ================================================================== */

const pkg = JSON.parse(read('package.json'))

eq('package name', pkg.name, '@local/mobile-console')
eq('package is private', pkg.private, true)
eq('package is ESM', pkg.type, 'module')
eq('host entry export', pkg.exports['.'], './index.js')
eq('client entry export', pkg.exports['./client'], './client.js')
eq('bundle patch is declared', pkg.dsh.bundle.patch, './cordis.patch.yml')
eq('client half is a web plugin', pkg.dsh.client.platform, 'web')
eq('client half activates immediately', pkg.dsh.client.immediately, true)
eq('client half injects the sidebar', pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar'])
check('the QR source module is not shipped',
  pkg.files.includes('qr.js') === false && pkg.exports['./qr'] === undefined,
  'qr.js is test-only source; shipping it would ship a second copy of the encoder')
check('every shipped file exists', pkg.files.every(name => {
  // `files` may hold globs (`locale/*.json`); only literal entries can be read.
  if (name.includes('*')) return true
  try {
    read(name.replace(/^\.\//u, ''))
    return true
  } catch (error) {
    return false
  }
}), pkg.files.join(', '))

/* ================================================================== *
 * 2. Patch layer
 * ================================================================== */

const patch = read('cordis.patch.yml')

check('the patch inserts one row', /-\s*insert:/u.test(patch) && patch.includes("name: '@local/mobile-console'"))
check('the patch row id is stable', patch.includes('id: mobile-console'))
check('the patch never re-binds the shared webserver row',
  !/id:\s*webserver/u.test(patch) && !patch.includes('0.0.0.0'),
  'a LAN bind is the bridge\'s job; a config override here would replace the whole webserver config')

/* ================================================================== *
 * 3. Host half — control routes
 * ================================================================== */

const host = await import(new URL('index.js', PLUGIN).href)

eq('host plugin name', host.name, 'mobile-console')
eq('host requires the web carrier', host.inject, ['webServer'])
eq('handoff path', host.HANDOFF_PATH, '/api/mobile-console/handoff')
eq('bridge path', host.BRIDGE_PATH, '/api/mobile-console/bridge')
check('host exports the bridge factory', typeof host.createBridge === 'function')
check('host exports the LAN address reader', typeof host.lanAddresses === 'function')
check('the LAN reader answers with strings',
  Array.isArray(host.lanAddresses()) && host.lanAddresses().every(value => typeof value === 'string'))

const TOKEN = 'TEST-TOKEN-0123456789'

/** A request stand-in with just the fields the control routes read. */
function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = new Map()
  return {
    method,
    url,
    headers,
    body,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return this
    },
    destroy() {},
    pipe() {},
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    },
  }
}

/** A response stand-in that records what the handler wrote. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString()
    },
  }
}

/**
 * Mount the plugin on a fake context.
 *
 * @param options - `port` (the fake GUI's loopback port) and `reject` (what
 * `connection.requestRejection` answers for a request).
 */
function mountHost({ port, reject = () => undefined }) {
  const routes = new Map()
  const effects = []
  const connection = {
    requestRejection: request => reject(request),
    authenticatedUrl(base) {
      const url = new URL(base)
      url.searchParams.set('token', TOKEN)
      return url.href
    },
  }
  const ctx = {
    webServer: {
      port,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    get(name) {
      return name === 'connection' ? connection : undefined
    },
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
      return () => {}
    },
  }
  host.apply(ctx)
  return {
    routes,
    effects,
    async dispose() {
      for (const entry of [...effects].reverse()) {
        if (typeof entry.cleanup === 'function') await entry.cleanup()
      }
    },
  }
}

async function callRoute(handler, request) {
  const response = fakeResponse()
  const pending = handler(request, response)
  if (request.body !== undefined) {
    request.emit('data', Buffer.from(request.body))
    request.emit('end')
  }
  await pending
  return response
}

{
  const mounted = mountHost({ port: 19387, reject: () => 401 })
  eq('two control routes are registered', mounted.routes.size, 2)
  check('the handoff route is registered', mounted.routes.has(host.HANDOFF_PATH))
  check('the bridge route is registered', mounted.routes.has(host.BRIDGE_PATH))
  check('every effect carries a label and a cleanup',
    mounted.effects.every(entry => typeof entry.label === 'string' && typeof entry.cleanup === 'function'))

  const denied = await callRoute(mounted.routes.get(host.HANDOFF_PATH), fakeRequest({}))
  eq('an unauthenticated handoff is refused', denied.status, 401)
  check('a refused handoff leaks no token', denied.body.includes(TOKEN) === false)
  eq('a refused handoff is not cacheable', denied.headers['cache-control'], 'no-store')

  const wrongMethod = await callRoute(mounted.routes.get(host.HANDOFF_PATH), fakeRequest({ method: 'PUT' }))
  eq('the handoff route rejects other methods', wrongMethod.status, 405)

  await mounted.dispose()
}
{
  const reject = request => (request.headers.cookie === 'ok' ? undefined : 401)
  const mounted = mountHost({ port: 19387, reject })

  const anonymous = await callRoute(mounted.routes.get(host.HANDOFF_PATH), fakeRequest({}))
  eq('a cookie-less caller is refused', anonymous.status, 401)

  const allowed = await callRoute(mounted.routes.get(host.HANDOFF_PATH), fakeRequest({ headers: { cookie: 'ok' } }))
  eq('an authenticated caller is answered', allowed.status, 200)
  const report = JSON.parse(allowed.body)
  eq('the bridge starts stopped', report.bridge, 'stopped')
  eq('a stopped bridge offers no URL', report.url, null)
  eq('the report names the GUI port', report.guiPort, 19387)
  check('a stopped bridge still explains itself', typeof report.hint === 'string' && report.hint.length > 0)

  const badBody = await callRoute(mounted.routes.get(host.BRIDGE_PATH), fakeRequest({
    method: 'POST',
    headers: { cookie: 'ok' },
    body: 'not json',
  }))
  eq('a malformed body is a bad request', badBody.status, 400)

  const badAction = await callRoute(mounted.routes.get(host.BRIDGE_PATH), fakeRequest({
    method: 'POST',
    headers: { cookie: 'ok' },
    body: JSON.stringify({ action: 'nope' }),
  }))
  eq('an unknown action is a bad request', badAction.status, 400)

  const notPost = await callRoute(mounted.routes.get(host.BRIDGE_PATH), fakeRequest({ headers: { cookie: 'ok' } }))
  eq('the bridge route rejects GET', notPost.status, 405)

  const deniedStart = await callRoute(mounted.routes.get(host.BRIDGE_PATH), fakeRequest({
    method: 'POST',
    body: JSON.stringify({ action: 'start' }),
  }))
  eq('an unauthenticated start is refused', deniedStart.status, 401)

  await mounted.dispose()
}

/* ================================================================== *
 * 4. Host half — the bridge, against a real upstream
 * ================================================================== */

/** A stand-in for the loopback GUI: records what it was asked, answers, upgrades. */
function startUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ kind: 'request', method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin })
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'keep-alive' })
    res.end('upstream-ok')
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ kind: 'upgrade', url: req.url, host: req.headers.host, origin: req.headers.origin })
    // An upgraded socket is `allowHalfOpen`, so the fixture must close its own
    // side when the peer half-closes or `server.close()` waits on it forever.
    socket.on('error', () => {})
    socket.on('end', () => socket.destroy())
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write('upstream-frame')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }))
  })
}

/** One HTTP GET through the bridge, presented as a LAN caller would. */
function getThroughBridge(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/?token=' + TOKEN,
      headers: { host: `192.168.1.24:${port}`, origin: `http://192.168.1.24:${port}` },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

/** One WebSocket handshake through the bridge. */
function upgradeThroughBridge(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/mux-events',
      headers: {
        host: `192.168.1.24:${port}`,
        origin: `http://192.168.1.24:${port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    })
    request.on('upgrade', (response, socket, head) => {
      resolve({ status: response.statusCode, upgrade: response.headers.upgrade, head: head.toString() })
      socket.destroy()
    })
    request.on('response', response => {
      reject(new Error(`the upgrade was answered as a plain response (${String(response.statusCode)})`))
    })
    request.on('error', reject)
    request.end()
  })
}

/** Whether nothing is listening on one port any more. */
function isClosed(port) {
  return new Promise(resolve => {
    const probe = http.request({ host: '127.0.0.1', port, path: '/' }, () => resolve(false))
    probe.on('error', () => resolve(true))
    probe.end()
  })
}

{
  const upstream = await startUpstream()
  const bridge = host.createBridge({ upstreamPort: upstream.port })
  const port = await bridge.listen()

  check('the bridge binds an OS-assigned port', Number.isInteger(port) && port > 0 && port !== upstream.port)

  const proxied = await getThroughBridge(port)
  eq('a proxied GET answers with the upstream body', proxied.body, 'upstream-ok')
  eq('a proxied GET answers with the upstream status', proxied.status, 200)

  const request = upstream.seen.find(entry => entry.kind === 'request')
  check('the upstream saw the request', request !== undefined)
  eq('the bridge rewrites Host to the loopback authority', request?.host, `127.0.0.1:${String(upstream.port)}`)
  eq('the bridge rewrites Origin to match', request?.origin, `http://127.0.0.1:${String(upstream.port)}`)
  eq('the bridge preserves the request target and its token', request?.url, '/?token=' + TOKEN)

  const upgraded = await upgradeThroughBridge(port)
  eq('an upgrade is answered 101', upgraded.status, 101)
  eq('the upgrade keeps the websocket protocol', upgraded.upgrade, 'websocket')
  eq('the upgraded socket carries upstream bytes', upgraded.head, 'upstream-frame')
  const seenUpgrade = upstream.seen.find(entry => entry.kind === 'upgrade')
  check('the upstream saw the upgrade', seenUpgrade !== undefined)
  eq('the upgrade rewrites Host too', seenUpgrade?.host, `127.0.0.1:${String(upstream.port)}`)

  await bridge.close()
  check('closing the bridge ends the listener', (await isClosed(port)) === true, 'the port still answered after close()')

  await new Promise(resolve => upstream.server.close(resolve))
}

/* -- the same bridge, driven through the control route -- */
{
  const upstream = await startUpstream()
  const mounted = mountHost({ port: upstream.port })

  const started = await callRoute(mounted.routes.get(host.BRIDGE_PATH), fakeRequest({
    method: 'POST',
    body: JSON.stringify({ action: 'start' }),
  }))
  eq('starting the bridge succeeds', started.status, 200)
  const live = JSON.parse(started.body)
  eq('the bridge reports itself listening', live.bridge, 'listening')
  check('the bridge reports the port it bound', Number.isInteger(live.bridgePort) && live.bridgePort > 0)

  const addresses = host.lanAddresses()
  if (addresses.length > 0) {
    check('a listening bridge offers one URL per LAN address', live.addresses.length === addresses.length)
    eq('the offered URL carries the launch token',
      live.url, `http://${addresses[0]}:${String(live.bridgePort)}/?token=${TOKEN}`)
  } else {
    eq('a bridge with no LAN address offers no URL', live.url, null)
    check('and says so', typeof live.hint === 'string' && live.hint.includes('局域网'))
  }

  const through = await getThroughBridge(live.bridgePort)
  eq('the route-built bridge proxies too', through.body, 'upstream-ok')

  // Disposal must close a bridge that is still up.
  await mounted.dispose()
  check('disposing the plugin closes the bridge', (await isClosed(live.bridgePort)) === true)

  const reopened = mountHost({ port: upstream.port })
  await callRoute(reopened.routes.get(host.BRIDGE_PATH), fakeRequest({
    method: 'POST',
    body: JSON.stringify({ action: 'start' }),
  }))
  const stopped = await callRoute(reopened.routes.get(host.BRIDGE_PATH), fakeRequest({
    method: 'POST',
    body: JSON.stringify({ action: 'stop' }),
  }))
  eq('stopping the bridge succeeds', stopped.status, 200)
  const stoppedReport = JSON.parse(stopped.body)
  eq('the bridge reports itself stopped', stoppedReport.bridge, 'stopped')
  eq('a stopped bridge offers no URL', stoppedReport.url, null)
  const afterStop = JSON.parse((await callRoute(reopened.routes.get(host.HANDOFF_PATH), fakeRequest({}))).body)
  eq('the handoff agrees that it stopped', afterStop.bridge, 'stopped')

  await reopened.dispose()
  await new Promise(resolve => upstream.server.close(resolve))
}

/* ================================================================== *
 * 5. Browser half — registration shape
 * ================================================================== */

const clientSource = read('client.js')

check('the browser half registers one module id',
  clientSource.includes('window.__ModuleLoader__.load(') && clientSource.includes("id: '@local/mobile-console'"))

const requires = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])
const SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
check('every require is a platform seed word',
  requires.every(specifier => SEED.has(specifier)),
  `unknown: ${requires.filter(specifier => !SEED.has(specifier)).join(', ')}`)
check('no relative require is attempted', requires.every(specifier => !specifier.startsWith('.')))

check('the browser half declares no Remote namespace',
  clientSource.includes('ctx.remote') === false && clientSource.includes('remote.session') === false,
  'the panel talks to its own Host half over HTTP; Remote belongs to the shipped GUI')
check('the browser half registers no waterfall listener', clientSource.includes('$on(') === false)
check('the browser half takes no shell takeover',
  clientSource.includes('documentElement') === false && clientSource.includes('html[data-mobile-console]') === false)
check('the browser half claims exactly one slot', (clientSource.match(/ctx\.slots\.register\(/gu) ?? []).length === 1)
check('the browser half claims the sidebar foot', clientSource.includes("'sidebar.footer.action'"))
check('the panel is dismissed by Escape', clientSource.includes("event.key === 'Escape'"))
check('the panel is dismissed from outside',
  clientSource.includes("document.addEventListener('mousedown'") && clientSource.includes('LAUNCHER_ATTR'))
check('the panel is a dialog', clientSource.includes("role: 'dialog'"))
check('the panel offers the connection steps', clientSource.includes('同一个 Wi-Fi') && clientSource.includes('扫描'))

/* ================================================================== *
 * 6. The inlined QR encoder equals plugin/qr.js
 * ================================================================== */

/** The markers `tools/inline-qr.mjs` writes around the inlined encoder. */
const START = '    /* @@inlined qr.js:start@@ */'
const END = '    /* @@inlined qr.js:end@@ */'

/**
 * Slice one inlined module out of `client.js`.
 *
 * The markers, not a brace matcher, are the boundary: source comments contain
 * apostrophes, and a naive string-aware scanner would lose its place on them.
 */
function extractIife(source, name) {
  const marker = `const ${name} = `
  const at = source.indexOf(marker)
  const end = source.indexOf(END, at)
  if (at === -1 || end === -1) throw new Error(`client.js has no marked ${name} block`)
  return source.slice(at + marker.length, end).trim()
}

const qrModule = await import(new URL('qr.js', PLUGIN).href)
const bundleQr = new Function(`return ${extractIife(clientSource, '__mcQr')}`)()

check('the inlined encoder exposes the same entry points',
  typeof bundleQr.encodeQr === 'function' && typeof bundleQr.assertEncoderSoundness === 'function')

const QR_PAYLOADS = [
  'A',
  'http://192.168.1.24:54321/?token=' + TOKEN,
  'http://10.0.0.7:19388/?token=' + 'f'.repeat(64),
  'x'.repeat(180),
]
check('the inlined encoder returns byte-identical matrices',
  QR_PAYLOADS.every(payload => JSON.stringify(bundleQr.encodeQr(payload)) === JSON.stringify(qrModule.encodeQr(payload))),
  'the block in client.js has drifted from plugin/qr.js')

/* The generator must be the thing that produced the file. */
const { renderInlinedQr } = await import(new URL('inline-qr.mjs', import.meta.url).href)
const from = clientSource.indexOf(START)
const to = clientSource.indexOf(END)
check('the marked QR block is present and ordered', from !== -1 && to > from)
eq('the marked QR block is exactly what the generator writes',
  clientSource.slice(from, to + END.length), renderInlinedQr())
check('client.js carries only the marked copy',
  clientSource.indexOf(START, from + 1) === -1)

/* ================================================================== *
 * 7. Encoder structure — both copies
 * ================================================================== */

for (const [label, encoder] of [['qr.js', qrModule], ['bundle', bundleQr]]) {
  const matrix = encoder.encodeQr('http://192.168.1.24:19387/?token=' + 'a'.repeat(43))
  check(`${label}: the symbol is square and in range`,
    matrix.size === matrix.modules.length && matrix.modules.every(row => row.length === matrix.size)
    && matrix.size >= 21 && matrix.size <= 57 && (matrix.size - 17) % 4 === 0)
  check(`${label}: the three finder patterns are present`,
    [[0, 0], [0, matrix.size - 7], [matrix.size - 7, 0]].every(([x, y]) => matrix.modules[y][x] === 1
      && matrix.modules[y + 1][x + 1] === 0 && matrix.modules[y + 3][x + 3] === 1))
  check(`${label}: the timing pattern alternates`,
    Array.from({ length: matrix.size - 16 }, (_, index) => matrix.modules[6][index + 8])
      .every((value, index) => value === (index % 2 === 0 ? 1 : 0)))
  check(`${label}: the always-dark module is dark`, matrix.modules[matrix.size - 8][8] === 1)
  eq(`${label}: soundness reports no failures`, encoder.assertEncoderSoundness('http://192.168.1.24:19387/?token=abc'), [])
  check(`${label}: an over-long payload is refused`,
    (() => {
      try {
        encoder.encodeQr('x'.repeat(400))
        return false
      } catch (error) {
        return true
      }
    })())
}

/* ================================================================== *
 * 8. Readability — independent decoder
 * ================================================================== */

try {
  const jsQR = (await import('jsqr')).default
  const { roundTrip } = await import(new URL('qr-decode.mjs', import.meta.url).href)
  const { passed: decoded, failures: decodeFailures, versions } = roundTrip(jsQR)
  check('every payload decodes through jsQR', decodeFailures.length === 0, decodeFailures.join('; '))
  check('the payload set spans several versions', versions.length >= 4, `versions ${versions.join(', ')}`)
  check('the decoder agrees with the payload count', decoded > 0)
} catch (error) {
  check('jsQR is installed (run pnpm install)', false, String(error && error.message ? error.message : error))
}

/* ================================================================== *
 * 9. Stylesheet
 * ================================================================== */

const cssStart = clientSource.indexOf('const CSS = `')
const cssEnd = clientSource.indexOf('`', cssStart + 'const CSS = `'.length)
const css = clientSource.slice(cssStart + 'const CSS = `'.length, cssEnd)

const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/gu)].map(match => match[1]))]
// A backtick inside the stylesheet would end the template literal early, which
// otherwise shows up only as a pile of unrelated style failures.
check('the stylesheet literal is not terminated early',
  css.length > 2000 && css.includes('.mc-window') && !css.includes('`'),
  'the CSS template literal ends inside itself — look for a backtick in one of its comments')
const unknown = used.filter(name => !THEME_TOKENS.has(name) && !name.startsWith('--mc-'))
check('the stylesheet only reads real theme tokens', unknown.length === 0, unknown.join(', '))
check('every --mc-* custom property is declared on the panel',
  used.filter(name => name.startsWith('--mc-')).every(name => css.includes(`${name}:`)))
check('the stylesheet hard-codes no colour',
  /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu.test(css) === false,
  'every surface colour comes from a theme token; the QR symbol is inline SVG, not CSS')
check('the panel is a fixed layer, not a takeover',
  css.includes('position: fixed') && css.includes('.mc-window') && css.includes('z-index'))
check('the panel has a narrow-screen layout', css.includes('@media'))
check('touch targets are at least 40px', css.includes('--mc-touch: 40px'))

/* The sidebar seat is a full-width capsule bar in the shell's chip row. */
const launcherCss = /\.mc-launcher \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? ''
check('the sidebar seat is a capsule', launcherCss.includes('border-radius: 999px'))
check('the capsule spans the footer row',
  launcherCss.includes('flex: 1 1 auto') && launcherCss.includes('width: 100%')
  && launcherCss.includes('justify-content: center'))
check('the capsule draws itself with a border and no fill of its own',
  launcherCss.includes('border: 1px solid var(--dsw-alias-border-l1)')
  && launcherCss.includes('background: transparent'))

/* Emphasis comes from the label, never from a filled accent block. */
const primaryCss = /\.mc-primary \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? ''
check('the primary action is not a filled accent block',
  primaryCss.includes('background: transparent') && primaryCss.includes('brand-primary') === false,
  'a solid --dsw-alias-brand-primary fill on this surface reads as a glare patch')

/* ================================================================== *
 * Report
 * ================================================================== */

if (failures.length > 0) {
  console.error(`mobile-console: ${String(failures.length)} check(s) failed`)
  for (const failure of failures) console.error('  ✗ ' + failure)
  process.exitCode = 1
} else {
  console.log(`mobile-console: ${String(passed)} assertions passed`)
  console.log('all checks passed')
}
