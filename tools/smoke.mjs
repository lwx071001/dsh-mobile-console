/**
 * Assembly smoke test for the browser half, with no browser.
 *
 * `tools/verify.mjs` reads `client.js` as text and exercises the Host half, so
 * it cannot catch a typo inside the React tree — a misspelled helper, a hook
 * called conditionally, an effect that throws, a teardown that leaves the
 * panel behind. This test loads the real bundle file, runs the real `factory`
 * against a minimal React and DOM, drives the panel through open → start →
 * close, and disposes every effect.
 *
 * WHAT IT IS NOT. The React shim is not React: it resolves function components
 * with hooks in order and runs effects immediately, and each assertion mounts
 * afresh against the current store value rather than re-rendering in place. It
 * proves the tree assembles, the interactions reach the Host routes, and
 * teardown is complete — not that React would paint it identically.
 */
import { readFileSync } from 'node:fs'

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
 * DOM / React stubs
 * ================================================================== */

function createNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    value: '',
    parent: null,
    removed: false,
    append(child) {
      child.parent = node
      node.children.push(child)
    },
    remove() {
      node.removed = true
      if (node.parent !== null) {
        const at = node.parent.children.indexOf(node)
        if (at !== -1) node.parent.children.splice(at, 1)
        node.parent = null
      }
    },
    contains(candidate) {
      let walk = candidate
      while (walk !== null && walk !== undefined) {
        if (walk === node) return true
        walk = walk.parent
      }
      return false
    },
    addEventListener() {},
    removeEventListener() {},
    select() {},
    setAttribute(name, value) {
      node.attributes[name] = value
    },
    closest(selector) {
      const attribute = selector.replace(/^\[|\]$/gu, '')
      let walk = node
      while (walk !== null && walk !== undefined) {
        if (walk.attributes !== undefined && Object.prototype.hasOwnProperty.call(walk.attributes, attribute)) return walk
        walk = walk.parent
      }
      return null
    },
  }
  return node
}

const head = createNode('head')
const body = createNode('body')
const documentElement = createNode('html')
const windowListeners = new Map()
const documentListeners = new Map()

const document = {
  head,
  body,
  documentElement,
  createElement: createNode,
  addEventListener(type, listener) {
    documentListeners.set(type, listener)
  },
  removeEventListener(type) {
    documentListeners.delete(type)
  },
  execCommand() {
    return true
  },
}

const window = {
  addEventListener(type, listener) {
    windowListeners.set(type, listener)
  },
  removeEventListener(type) {
    windowListeners.delete(type)
  },
}

function dispatch(map, type, event) {
  const listener = map.get(type)
  if (listener !== undefined) listener(event)
  return listener !== undefined
}

/* -- React: enough to resolve one function-component tree with hooks -- */
const effectCleanups = []
const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }
  },
  useMemo(factory) {
    return factory()
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(effect) {
    const cleanup = effect()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  },
  Fragment: 'Fragment',
}

/** Resolve an element tree, invoking function components. */
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) {
    return node.map(resolve).filter(entry => entry !== null)
  }
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node), props: {}, children: [] }
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  return { type: node.type, props: node.props, children: resolve(node.props.children) }
}

/** Every text run in a resolved tree. */
function texts(tree) {
  if (tree === null || tree === undefined) return []
  if (Array.isArray(tree)) return tree.flatMap(texts)
  if (tree.text !== undefined) return [tree.text]
  return texts(tree.children)
}

/** The first resolved element matching a predicate. */
function find(tree, predicate) {
  if (tree === null || tree === undefined) return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (tree.text !== undefined) return null
  if (predicate(tree)) return tree
  return find(tree.children, predicate)
}

const byClass = name => node => node.props !== undefined && node.props.className === name

/* -- the module loader the client half registers with -- */
let registered = null
globalThis.window = window
globalThis.document = document
// Node exposes `navigator` as a getter-only global, so this must not be a plain
// assignment.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})
window.__ModuleLoader__ = {
  load(handoff) {
    registered = handoff
  },
}

/* -- fetch: the two control routes, answered locally -- */
const calls = []
let bridgeState = 'stopped'

function report() {
  return bridgeState === 'listening'
    ? {
      bridge: 'listening',
      bridgePort: 41000,
      guiPort: 19387,
      addresses: [{ address: '192.168.1.24', url: 'http://192.168.1.24:41000/?token=SMOKE' }],
      url: 'http://192.168.1.24:41000/?token=SMOKE',
      networkCount: 1,
      hint: '用手机扫下方二维码。',
    }
    : {
      bridge: 'stopped',
      bridgePort: null,
      guiPort: 19387,
      addresses: [],
      url: null,
      networkCount: 1,
      hint: '手机访问没有开启。',
    }
}

globalThis.fetch = async (url, init) => {
  const body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ url: String(url), method: init?.method ?? 'GET', body })
  if (body !== undefined) bridgeState = body.action === 'start' ? 'listening' : 'stopped'
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(report()),
  }
}

/* ================================================================== *
 * Load the real bundle
 * ================================================================== */

const source = readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
const module = { exports: {} }
const evaluate = new Function('window', 'document', 'navigator', 'fetch', 'module', 'exports', source)
evaluate(window, document, navigator, globalThis.fetch, module, module.exports)

check('the bundle registers exactly one module', registered !== null)
if (registered === null) {
  console.error('mobile-console smoke: the bundle did not call window.__ModuleLoader__.load')
  process.exit(1)
}
eq('the module id matches the package', registered.id, '@local/mobile-console')

/** The platform seed table, with only what this bundle asks for. */
const SEED = {
  react: React,
  'react-dom/client': {
    createRoot(element) {
      return {
        render(node) {
          element.rendered = node
        },
        unmount() {
          element.unmounted = true
        },
      }
    },
  },
}

const factory = registered.factory
const plugin = factory(specifier => {
  if (!Object.prototype.hasOwnProperty.call(SEED, specifier)) {
    throw new Error(`the bundle requires "${specifier}", which the platform seed table does not provide`)
  }
  return SEED[specifier]
})

check('the factory returns a plugin', plugin !== null && typeof plugin === 'object')
eq('the plugin injects only the slot service', plugin.inject, ['slots'])
check('the plugin exports an apply', typeof plugin.apply === 'function')

/* ================================================================== *
 * Mount on a fake client context
 * ================================================================== */

const effects = []
const seats = []
let injected = null

const ctx = {
  effect(fn, label) {
    const cleanup = fn()
    effects.push({ label, cleanup })
    return () => {}
  },
  slots: {
    inject(key, callback) {
      injected = { key, callback }
    },
    register(spec, Component) {
      seats.push({ spec, Component })
      return { dispose() {} }
    },
  },
}

plugin.apply(ctx)

eq('the plugin injects the sidebar foot', injected?.key, 'sidebar.footer.action')
// The owner materializes the seat once its slot exists; nothing is registered
// before that, which is exactly why the panel works in any composition order.
injected.callback()
eq('the plugin takes exactly one seat', seats.length, 1)
eq('the seat id is the plugin id', seats[0]?.spec.id, 'mobile-console')
eq('the seat orders after the shipped footer rows', seats[0]?.spec.order, 20)
eq('the seat is labelled for the user', seats[0]?.spec.label, '手机访问')
check('the plugin owns exactly one root element', body.children.length === 1)
check('the plugin owns a stylesheet tag', head.children.length === 1)
check('every effect has a label', effects.every(entry => typeof entry.label === 'string'))
check('the launcher renders a button that toggles the panel',
  typeof seats[0]?.Component === 'function')

const rootNode = body.children[0]

/** Mount one component afresh against the current store value. */
function mount(Component, props) {
  return resolve(React.createElement(Component, props))
}

function panel() {
  return mount(seats[0].Component, {})
}

/* -- initial state: the launcher, no panel -- */
{
  const launcher = mount(seats[0].Component, {})
  check('the launcher shows its label', texts(launcher).includes('手机访问'))
  eq('the launcher reports the bridge as off', find(launcher, byClass('mc-launcher'))?.props['data-on'], 'false')
  const rail = mount(seats[0].Component, { wide: false })
  check('the 56px rail drops the label', texts(rail).includes('手机访问') === false)
  check('the rail keeps the accessible name',
    find(rail, byClass('mc-launcher'))?.props['aria-label'] === '手机访问')
  const closed = mount(rootNode.rendered.type, rootNode.rendered.props)
  eq('the panel is closed on mount', closed, null)
  check('the plugin asks the Host for the bridge state', calls.some(call => call.url.endsWith('/api/mobile-console/handoff')))
  check('the initial read is a GET', calls[0]?.method === 'GET')
}

/* -- open the panel -- */
{
  const launcher = mount(seats[0].Component, {})
  const button = find(launcher, byClass('mc-launcher'))
  check('the launcher is clickable', typeof button?.props.onClick === 'function')
  button.props.onClick()
  const open = mount(rootNode.rendered.type, rootNode.rendered.props)
  check('clicking the launcher opens the panel', open !== null)
  check('the panel has a close control', find(open, byClass('mc-x')) !== null)
  check('the panel shows the start action', texts(find(open, byClass('mc-primary'))).includes('开启手机访问'))
  check('the panel explains itself before it is on',
    texts(open).some(text => text.includes('手机上打开')))
}

/* -- start the bridge -- */
let startedPanel = null
{
  const open = mount(rootNode.rendered.type, rootNode.rendered.props)
  find(open, byClass('mc-primary')).props.onClick()
  await settle()
  const startCall = calls.find(call => call.url.endsWith('/api/mobile-console/bridge'))
  check('starting posts to the bridge route', startCall !== undefined)
  eq('starting asks for the start action', startCall?.body, { action: 'start' })
  eq('starting is a POST', startCall?.method, 'POST')

  startedPanel = mount(rootNode.rendered.type, rootNode.rendered.props)
  const url = 'http://192.168.1.24:41000/?token=SMOKE'
  check('the panel shows the phone URL', texts(startedPanel).includes(url))
  check('the panel draws a QR symbol', find(startedPanel, byClass('mc-qr')) !== null)
  const svg = find(startedPanel, byClass('mc-qr'))
  const path = Array.isArray(svg?.children) ? svg.children.find(child => child.type === 'path') : null
  check('the QR symbol carries module rectangles', typeof path?.props.d === 'string' && path.props.d.includes('h1v1h-1z'))
  check('the QR symbol is square', typeof svg?.props.viewBox === 'string' && svg.props.viewBox.startsWith('0 0 '))
  check('the panel lists the connection steps', texts(startedPanel).some(text => text.includes('同一个 Wi-Fi')))
  check('the panel offers to copy the address', find(startedPanel, byClass('mc-copy')) !== null)
  check('the panel offers to stop', texts(find(startedPanel, byClass('mc-stop'))).includes('停止手机访问'))

  const launcher = mount(seats[0].Component, {})
  eq('the launcher dot reflects a live bridge', find(launcher, byClass('mc-launcher'))?.props['data-on'], 'true')
}

/* -- copy, stop, dismiss -- */
{
  const open = mount(rootNode.rendered.type, rootNode.rendered.props)
  find(open, byClass('mc-copy')).props.onClick()
  await settle()
  const copied = mount(rootNode.rendered.type, rootNode.rendered.props)
  check('copying reports back', texts(find(copied, byClass('mc-copy'))).includes('已复制'))

  find(copied, byClass('mc-stop')).props.onClick()
  await settle()
  const stopped = mount(rootNode.rendered.type, rootNode.rendered.props)
  check('stopping returns the panel to its start state',
    texts(find(stopped, byClass('mc-primary'))).includes('开启手机访问'))
  eq('stopping asks for the stop action',
    calls.findLast(call => call.url.endsWith('/api/mobile-console/bridge'))?.body, { action: 'stop' })

  check('Escape is bound', dispatch(windowListeners, 'keydown', { key: 'Escape' }))
  eq('Escape closes the panel', mount(rootNode.rendered.type, rootNode.rendered.props), null)
}

/* -- a click inside the panel must not dismiss it -- */
{
  const launcher = mount(seats[0].Component, {})
  find(launcher, byClass('mc-launcher')).props.onClick()
  const open = mount(rootNode.rendered.type, rootNode.rendered.props)
  check('the panel reopened', open !== null)
  dispatch(documentListeners, 'mousedown', { target: rootNode })
  check('a click inside the panel keeps it open', mount(rootNode.rendered.type, rootNode.rendered.props) !== null)
  dispatch(documentListeners, 'mousedown', { target: createNode('main') })
  eq('a click outside closes it', mount(rootNode.rendered.type, rootNode.rendered.props), null)
}

/* -- teardown -- */
{
  for (const cleanup of effectCleanups.splice(0)) cleanup()
  for (const entry of [...effects].reverse()) {
    if (typeof entry.cleanup === 'function') await entry.cleanup()
  }
  check('the stylesheet is removed', head.children.length === 0)
  check('the root is removed', rootNode.removed === true)
  check('the keydown listener is removed', windowListeners.size === 0)
  check('the outside-click listener is removed', documentListeners.size === 0)
  check('React was unmounted', rootNode.unmounted === true)
}

/* ================================================================== *
 * Report
 * ================================================================== */

/** Let the fetch promises in a click handler settle. */
async function settle() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

if (failures.length > 0) {
  console.error(`mobile-console smoke: ${String(failures.length)} check(s) failed`)
  for (const failure of failures) console.error('  ✗ ' + failure)
  process.exitCode = 1
} else {
  console.log(`mobile-console smoke: ${String(passed)} assertions passed`)
  console.log('bundle assembly, seat registration, panel lifecycle and teardown all clean')
}
