/**
 * Shared helpers for the plugin's local HTTP surface: the loopback shim.
 * Both the inbound gates and the port selection exist because the shim is
 * only ever meant to be addressed through the machine's loopback interface.
 *
 * @module dsh-loomy-connect/loopback
 */

/** Loopback hostnames a local plugin surface may be addressed by. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host) {
  let hostname = String(host ?? '').trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page sends its own domain in Host, so this check drops those before any
 * routing happens.
 */
export function hostIsLoopback(host) {
  if (host === undefined || host === null || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser clients
 * send no Origin at all and pass.
 */
export function originIsLoopback(origin) {
  if (origin === undefined || origin === null || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Ports fetch refuses to connect to, per the fetch standard's port blocking
 * table. Only the entries a host's ephemeral range can actually reach matter,
 * but carrying the whole list costs nothing and keeps the check honest.
 */
export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
])

/** Whether fetch (and therefore pi-ai) refuses to connect to `port`. */
export function isFetchBlockedPort(port) {
  return FETCH_BLOCKED_PORTS.has(port)
}

/** Bind attempts allowed before giving up, including the first. */
const DEFAULT_MAX_ATTEMPTS = 16

/**
 * Bind `server` to an ephemeral port fetch will actually connect to, and
 * resolve with the address it ended up on.
 *
 * `listen(0)` lets the OS hand out any free ephemeral port, and a handful of
 * the ports it can hand out are on the fetch standard's bad-port list: fetch
 * refuses to connect to them and fails with `TypeError: fetch failed` before a
 * socket is opened. The shim is only ever reached through fetch (pi-ai calls
 * it), so settling on one of those ports leaves the plugin with an endpoint
 * that answers raw HTTP and rejects every real request.
 */
export async function bindToUsablePort(server, options) {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const isPortBlocked = options?.isPortBlocked ?? isFetchBlockedPort
  const host = options.host
  let lastBlockedPort = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const address = await listenOnEphemeralPort(server, host)
    if (!isPortBlocked(address.port)) return address
    lastBlockedPort = address.port
    options?.onBlockedPort?.(address.port, attempt)
    await closeQuietly(server)
  }
  throw new Error(
    `could not bind a fetch-reachable loopback port after ${maxAttempts} attempts `
    + `(last blocked port: ${lastBlockedPort})`,
  )
}

/** One `listen(0)` on `host`, resolving with the address the OS handed out. */
function listenOnEphemeralPort(server, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }
    const onListening = () => {
      cleanup()
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('loomy shim has no listening address'))
        return
      }
      resolve(address)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(0, host)
  })
}

/** Close between attempts; a listener that already closed is not an error. */
function closeQuietly(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}
