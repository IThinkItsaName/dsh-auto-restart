/**
 * Read-only status route for the browser half.
 *
 * The page polls it once after a restart to learn which drafts the killed
 * renderer left stale. Mounting is best-effort: a headless profile has no web
 * server and must still load the host half. The service can also arrive after
 * activation, so registration retries briefly.
 */
export const STATUS_ROUTE_PATH = '/plugins/dsh-auto-restart/status.json'

const REGISTER_ATTEMPTS = 20
const REGISTER_INTERVAL_MS = 500

/** @param {object} ctx @param {{ snapshot: () => object }} state @param {(msg: string) => void} [warn] */
export function mountStatusRoute(ctx, state, warn = () => {}) {
  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    let body
    try {
      body = JSON.stringify(state.snapshot())
    } catch (error) {
      warn(`auto-restart: status serialization failed: ${String(error?.message ?? error)}`)
      body = '{"draftHints":{"at":0,"sessions":[]}}'
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  let routeDisposer = null
  let timer = null
  let attempts = 0

  function webServer() {
    try {
      const service = ctx.get('webServer')
      return service !== null && typeof service === 'object' ? service : null
    } catch {
      return null
    }
  }

  function registerNow() {
    const service = webServer()
    if (service === null || typeof service.register !== 'function') return false
    routeDisposer = service.register({ kind: 'exact', path: STATUS_ROUTE_PATH, handler })
    return true
  }

  if (!registerNow()) {
    timer = setInterval(() => {
      attempts += 1
      if (registerNow() || attempts >= REGISTER_ATTEMPTS) {
        clearInterval(timer)
        timer = null
      }
    }, REGISTER_INTERVAL_MS)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (routeDisposer !== null) {
      try {
        routeDisposer()
      } catch (error) {
        warn(`auto-restart: releasing the status route failed: ${String(error?.message ?? error)}`)
      }
      routeDisposer = null
    }
  }
}
