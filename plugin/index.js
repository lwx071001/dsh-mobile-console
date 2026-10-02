/**
 * mobile-console — HOST half.
 *
 * The whole feature is one question: how does a phone browser reach this
 * Harness? The Desktop application answers it by accident — it starts the Web
 * server with `--port 19387` and no `--host`, so `dsh-host-webserver` binds
 * `127.0.0.1` and only this machine can ever reach the GUI. A QR code pointing
 * at a LAN address is therefore not "not configured yet": it is unreachable by
 * construction, which is why this half owns a bridge instead of a hint.
 *
 * TWO FACTS THIS HALF PROVIDES
 *
 * 1. `/api/mobile-console/handoff` (GET) — is the bridge up, and what URL does
 *    the phone open? The URL carries this process's launch token, which is a
 *    bearer credential, so the route is answered only to a caller that already
 *    holds a valid browser session (`ctx.connection.requestRejection`).
 * 2. `/api/mobile-console/bridge` (POST) — start or stop the bridge, the LAN
 *    listener the panel's switch drives.
 *
 * WHY A BRIDGE AND NOT `--host 0.0.0.0`. Re-binding is a boot-time config fact:
 * it would need a profile patch (this bundle must not rewrite the profile), a
 * restart, and it widens the exposure of the *whole* deployment permanently.
 * The bridge is scoped — one listening socket, only while the user has the
 * switch on, gone the moment the plugin is disposed — and it works in the
 * Desktop application, where no command line is available at all.
 *
 * WHY IT IS A TRUSTED PROXY. The bridge forwards to the loopback GUI with
 * `Host` and `Origin` rewritten to the loopback authority, so every request
 * arrives at `dsh-client-connection` looking exactly like the desktop window's
 * own request: past the DNS-rebinding fence, and authenticated by the *same*
 * signed browser cookie the GUI already issues. The bridge adds no
 * authentication of its own and holds no secret: a phone that has not presented
 * the launch token through `/` is answered the GUI's own 401, byte for byte.
 * Nothing is terminated here — bodies, compression, and WebSocket frames are
 * piped verbatim, so the phone runs the shipped GUI rather than a second,
 * thinner implementation of it that could drift.
 */

import http from 'node:http'
import net from 'node:net'
import { networkInterfaces } from 'node:os'

export const name = 'mobile-console'

/** The Web carrier is required: without it there is no route and no upstream. */
export const inject = ['webServer']

/** Read the bridge state and the phone URL. `GET` only. */
export const HANDOFF_PATH = '/api/mobile-console/handoff'

/** Start or stop the bridge. `POST` with `{"action":"start"|"stop"}`. */
export const BRIDGE_PATH = '/api/mobile-console/bridge'

/** The loopback literal the upstream GUI always answers on. */
const LOOPBACK = '127.0.0.1'

/** The all-interfaces listener the bridge binds: this is the LAN door. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/** Largest control-route body accepted; the switch sends one short field. */
const MAX_CONTROL_BODY_BYTES = 4096

/**
 * Headers that describe one hop and must not be forwarded across the bridge.
 * `content-length`/`content-encoding` are deliberately absent: the payload is
 * piped unchanged, so the upstream's framing stays true.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Collect this machine's non-internal IPv4 literals.
 *
 * Mirrors `web-app`'s own LAN derivation, so the addresses offered to the phone
 * are the same set a `--host 0.0.0.0` deployment would print.
 *
 * @returns addresses in `networkInterfaces()` order, deduplicated.
 */
export function lanAddresses() {
  const found = []
  for (const iface of Object.values(networkInterfaces()).flat()) {
    if (iface === undefined) continue
    // `family` is a number on old Node and a string on new Node; accept both.
    const family = typeof iface.family === 'string' ? iface.family : String(iface.family)
    if (family !== 'IPv4' && family !== '4') continue
    if (iface.internal === true) continue
    if (!found.includes(iface.address)) found.push(iface.address)
  }
  return found
}

/** Rewrite the two request headers that name the caller's authority. */
function forwardHeaders(req, upstreamPort) {
  const headers = { ...req.headers }
  const authority = `${LOOPBACK}:${String(upstreamPort)}`
  headers.host = authority
  // The fence compares Origin against Host; the caller's real origin is the
  // bridge, which is exactly the hop being replaced.
  if (typeof headers.origin === 'string') headers.origin = `http://${authority}`
  return headers
}

/** Drop per-hop response headers so the downstream connection frames its own. */
function responseHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

/**
 * Rebuild an upgrade request's raw head for the upstream socket.
 *
 * WebSocket upgrades cannot go through `http.request` unchanged, and the
 * handshake must survive byte for byte (`Sec-WebSocket-Key`, extensions,
 * subprotocols), so the head is replayed with only the authority rewritten.
 */
function rawRequestHead(req, upstreamPort) {
  const authority = `${LOOPBACK}:${String(upstreamPort)}`
  const lines = [`${String(req.method)} ${String(req.url)} HTTP/1.1`]
  const raw = req.rawHeaders
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index]
    const value = raw[index + 1]
    const lower = String(key).toLowerCase()
    if (lower === 'host') lines.push(`Host: ${authority}`)
    else if (lower === 'origin') lines.push(`Origin: http://${authority}`)
    else lines.push(`${String(key)}: ${String(value)}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Build the LAN bridge for one upstream loopback port.
 *
 * The returned object owns a `node:http` server that is not listening yet, so a
 * caller can bind it, report the OS-assigned port, and close it again without
 * touching the upstream GUI at all.
 *
 * @param options - `upstreamPort`: the loopback port of the running GUI.
 * @returns the bridge's `listen`/`close` control surface and its server.
 */
export function createBridge({ upstreamPort }) {
  /**
   * Every socket the bridge has accepted, upgraded ones included. `close()`
   * needs this list because `server.close()` waits for open connections, and
   * Node's `closeAllConnections()` deliberately excludes upgraded sockets.
   */
  const sockets = new Set()

  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: LOOPBACK,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, upstreamPort),
      // One socket per proxied request. A pooled upstream socket outlives the
      // caller that caused it, which would keep the loopback GUI's connection
      // count growing for no benefit — the browser already keeps its own
      // keep-alive connection to the bridge.
      agent: false,
    })
    upstream.on('response', response => {
      res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers))
      response.pipe(res)
      // The upstream hop is one request long; releasing it here is what keeps
      // the GUI's own socket count flat across a phone's page load.
      response.on('end', () => upstream.destroy())
    })
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      res.end('mobile-console: the loopback GUI did not answer.\n')
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(upstreamPort, LOOPBACK, () => {
      upstream.write(rawRequestHead(req, upstreamPort))
      if (head !== undefined && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    const bail = () => {
      socket.destroy()
      upstream.destroy()
    }
    // An upgraded socket arrives with `allowHalfOpen: true`, so a client FIN
    // surfaces as `end` and the socket then stays open forever — `close` never
    // fires. Forwarding the half-close in both directions is what actually ends
    // the pair; without it every phone that closes its tab leaves one upstream
    // socket behind.
    socket.on('end', () => upstream.end())
    upstream.on('end', () => socket.end())
    upstream.on('error', bail)
    socket.on('error', bail)
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  })

  // A malformed request must not kill the listener with an unhandled error.
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
  })

  return {
    server,
    /**
     * Bind every interface on an OS-assigned port.
     *
     * Port 0 is deliberate: the bridge must never collide with the GUI's own
     * port, a second Harness, or anything else the user runs, and the phone
     * learns the real port from the QR code rather than from a constant.
     *
     * @returns the bound port.
     */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = error => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          const address = server.address()
          resolve(typeof address === 'object' && address !== null ? address.port : 0)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, ALL_INTERFACES_HOST)
      })
    },
    /** Stop listening and drop every proxied socket, upgraded ones included. */
    close() {
      return new Promise(resolve => {
        for (const socket of [...sockets]) socket.destroy()
        sockets.clear()
        server.close(() => resolve())
      })
    },
  }
}

/** Read a small control body, or `undefined` when it is missing or oversized. */
function readControlBody(req) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_CONTROL_BODY_BYTES) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(undefined))
  })
}

/**
 * Register the bridge control and handoff routes.
 *
 * @param ctx - plugin context carrying the `webServer` carrier.
 */
export function apply(ctx) {
  /** The live bridge, or `null` while the LAN door is shut. */
  let bridge = null
  /** Its bound port; meaningful only while `bridge !== null`. */
  let bridgePort = 0

  function connection() {
    const service = ctx.get('connection')
    return service === undefined || service === null ? undefined : service
  }

  function send(req, res, status, body) {
    const payload = Buffer.from(body, 'utf8')
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': payload.byteLength,
    }
    res.writeHead(status, headers)
    res.end(req.method === 'HEAD' ? undefined : payload)
  }

  /**
   * Admit one control call.
   *
   * The handoff value carries the process launch token, so the route answers
   * only a caller `client-connection` already authenticated — the desktop page
   * that is asking on its user's behalf. Without that service the value cannot
   * be built at all, which is reported rather than papered over.
   */
  function authorized(req, res) {
    const service = connection()
    if (service === undefined || typeof service.requestRejection !== 'function') {
      send(req, res, 503, JSON.stringify({ error: 'connection-unavailable', message: '当前部署没有可用的浏览器会话服务。' }))
      return false
    }
    const rejection = service.requestRejection(req)
    if (rejection !== undefined) {
      send(req, res, rejection, JSON.stringify({
        error: rejection === 401 ? 'unauthorized' : 'forbidden',
        message: '这个接口只回答已登录的浏览器页面。',
      }))
      return false
    }
    return true
  }

  /** The current answer: bridge state plus a phone URL when there is one. */
  function handoff() {
    const addresses = lanAddresses()
    const service = connection()
    const listening = bridge !== null
    const links = listening && service !== undefined
      ? addresses.map(address => ({
        address,
        // The launch token is what makes a LAN URL work at all: the cookie the
        // GUI issues is bound to the authority it was minted for, so the phone
        // needs its own exchange. `authenticatedUrl` is the product's own
        // minting seam, and it is only ever reached through the gate above.
        url: service.authenticatedUrl(`http://${address}:${String(bridgePort)}`),
      }))
      : []

    let hint
    if (!listening) {
      hint = '手机访问没有开启。开启后会建立一个只监听本机局域网的通道，用二维码在手机上打开同一个界面。'
    } else if (links.length === 0) {
      hint = '通道已开启，但没有找到局域网 IPv4 地址。请确认这台电脑已连接 Wi-Fi 或有线网络。'
    } else {
      hint = '用手机扫下方二维码。打开的就是这台电脑上的同一个 DSH 界面、同一份会话。'
    }

    return {
      bridge: listening ? 'listening' : 'stopped',
      bridgePort: listening ? bridgePort : null,
      guiPort: ctx.webServer.port,
      addresses: links,
      url: links.length > 0 ? links[0].url : null,
      networkCount: addresses.length,
      hint,
    }
  }

  async function startBridge() {
    if (bridge !== null) return
    const created = createBridge({ upstreamPort: ctx.webServer.port })
    try {
      bridgePort = await created.listen()
    } catch (error) {
      await created.close()
      throw error
    }
    bridge = created
  }

  async function stopBridge() {
    if (bridge === null) return
    const closing = bridge
    bridge = null
    bridgePort = 0
    await closing.close()
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HANDOFF_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(req, res, 405, JSON.stringify({ error: 'method-not-allowed' }))
        return
      }
      if (!authorized(req, res)) return
      send(req, res, 200, JSON.stringify(handoff()))
    },
  }), 'mobile-console: handoff route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BRIDGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(req, res, 405, JSON.stringify({ error: 'method-not-allowed' }))
        return
      }
      if (!authorized(req, res)) return
      let action
      try {
        const body = await readControlBody(req)
        action = body === undefined ? undefined : JSON.parse(body).action
      } catch (error) {
        send(req, res, 400, JSON.stringify({ error: 'bad-body' }))
        return
      }
      if (action !== 'start' && action !== 'stop') {
        send(req, res, 400, JSON.stringify({ error: 'unknown-action' }))
        return
      }
      try {
        if (action === 'start') await startBridge()
        else await stopBridge()
      } catch (error) {
        send(req, res, 500, JSON.stringify({
          error: 'bridge-failed',
          message: String(error && error.message ? error.message : error),
        }))
        return
      }
      send(req, res, 200, JSON.stringify(handoff()))
    },
  }), 'mobile-console: bridge route')

  // Disposal must not leave a listening socket behind. The cleanup returns the
  // closing promise so a caller that awaits teardown observes a closed port
  // rather than a race with it.
  ctx.effect(() => () => stopBridge(), 'mobile-console: bridge teardown')
}
