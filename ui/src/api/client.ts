// The lowest layer of talking to the server. Every call goes to /emby/..., as Emby's own
// clients do; the handler strips the prefix before routing. The token travels in
// X-Emby-Token, and X-Emby-Authorization names this client and device so the session list
// can tell a browser from a television.

import { ApiError } from './error'

const TOKEN_KEY = 'emby-users.token'
const DEVICE_KEY = 'emby-users.device'

export const CLIENT = { name: '网页端', version: '1.0' }

let onUnauthorized: (() => void) | null = null

export function onSignedOut(fn: () => void) {
    onUnauthorized = fn
}

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
}

/** One device id per browser: the handler keeps one session per device, so signing in again replaces the old token. */
export function deviceId(): string {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
        id = crypto.randomUUID().replaceAll('-', '')
        localStorage.setItem(DEVICE_KEY, id)
    }
    return id
}

function deviceName(): string {
    const ua = navigator.userAgent
    const os = /iPhone/.test(ua)
        ? 'iPhone'
        : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
          ? 'iPad'
          : /Android/.test(ua)
            ? 'Android'
            : /Mac OS/.test(ua)
              ? 'Mac'
              : /Windows/.test(ua)
                ? 'Windows'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : '浏览器'
    const browser = /Edg\//.test(ua)
        ? 'Edge'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : ''
    return browser ? `${os} · ${browser}` : os
}

/** fetch rejects non-ASCII header values; names are URL-encoded and the handler decodes them. */
function authorizationHeader(): string {
    const q = (v: string) => `"${encodeURIComponent(v)}"`
    return `Emby Client=${q(CLIENT.name)}, Device=${q(deviceName())}, DeviceId=${q(deviceId())}, Version=${q(CLIENT.version)}`
}

export type Query = Record<string, string | number | boolean | undefined | null>

export function qs(params?: Query): string {
    if (!params) return ''
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue
        sp.set(k, String(v))
    }
    const s = sp.toString()
    return s ? `?${s}` : ''
}

/** A URL for <img>, <video> and <track>, which cannot send headers: the token goes in the query. */
export function mediaUrl(path: string, params?: Query): string {
    return `/emby${path}${qs({ ...params, api_key: getToken() ?? undefined })}`
}

/** A path the server handed out (TranscodingUrl) already carries its query and token. */
export function serverUrl(path: string): string {
    return /^\/emby\//i.test(path) ? path : `/emby${path.startsWith('/') ? '' : '/'}${path}`
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE'
    query?: Query
    body?: unknown
    /** Sign-in has no token and must not sign anyone out on a 401. */
    anonymous?: boolean
    signal?: AbortSignal
    keepalive?: boolean
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Emby-Authorization': authorizationHeader(),
    }
    const token = getToken()
    if (token && !opts.anonymous) headers['X-Emby-Token'] = token
    let body: string | undefined
    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(opts.body)
    }
    const res = await fetch(`/emby${path}${qs(opts.query)}`, {
        method: opts.method ?? 'GET',
        headers,
        body,
        signal: opts.signal,
        keepalive: opts.keepalive,
        credentials: 'omit',
    })
    if (res.status === 401 && !opts.anonymous) onUnauthorized?.()
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
}
