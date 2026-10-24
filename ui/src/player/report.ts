// Playback reports, as Emby's own clients send them: Playing when it starts, Progress every
// ten seconds and on pause, Stopped when it ends or the page goes away. The handler keeps
// them per user. A transcode also gets a ping every half minute and is ended explicitly on
// stop, so the upstream server does not keep encoding for nobody.

import { useEffect, useMemo, useRef } from 'react'
import { deviceId, getToken } from '../api/client'
import * as emby from '../api/emby'
import { secondsToTicks } from '../format'
import type { Source } from './source'

const REPORT_EVERY = 10_000
const PING_EVERY = 30_000

export interface Reporter {
    playing(): void
    paused(): void
    time(seconds: number): void
    ended(duration: number): void
    /** A new source for the same item (another audio track, quality or subtitle). */
    switched(): void
}

export function usePlaybackReport(
    itemId: string,
    source: Source | undefined,
    selection: { audio?: number; subtitle?: number },
): Reporter {
    const started = useRef(false)
    const stopped = useRef(false)
    const position = useRef(0)
    const last = useRef(0)
    const state = useRef({ itemId, source, selection })
    state.current = { itemId, source, selection }

    // Keep a transcode alive while it plays, and end it when this source is left behind.
    useEffect(() => {
        if (!source || source.method === 'DirectPlay') return
        const psid = source.playSessionId
        const t = setInterval(() => void emby.ping(psid).catch(() => {}), PING_EVERY)
        return () => {
            clearInterval(t)
            emby.stopEncoding(psid, true).catch(() => {})
        }
    }, [source])

    // One object for the whole visit: everything it sends is read from refs at the moment it sends.
    const reporter = useMemo(() => {
        const body = (paused: boolean): emby.PlayReport | null => {
            const { itemId, source: s, selection: sel } = state.current
            if (!s) return null
            return {
                ItemId: itemId,
                MediaSourceId: s.media.Id,
                PlaySessionId: s.playSessionId,
                PositionTicks: secondsToTicks(position.current),
                IsPaused: paused,
                PlayMethod: s.method,
                AudioStreamIndex: sel.audio,
                SubtitleStreamIndex: sel.subtitle,
            }
        }
        const send = (kind: 'start' | 'progress' | 'stop', paused = false, keepalive = false) => {
            const b = body(paused)
            if (!b) return
            const call =
                kind === 'start'
                    ? emby.reportPlaying(b)
                    : kind === 'progress'
                      ? emby.reportProgress(b)
                      : emby.reportStopped(b, keepalive)
            call.catch(() => {})
        }
        return {
            body,
            send,
            playing() {
                if (!started.current || stopped.current) {
                    started.current = true
                    stopped.current = false
                    last.current = Date.now()
                    send('start')
                } else if (Date.now() - last.current > 2000) {
                    // Every resume after a seek or a stall fires playing; one report per burst is enough.
                    last.current = Date.now()
                    send('progress')
                }
            },
            paused() {
                if (started.current && !stopped.current) send('progress', true)
            },
            time(t: number) {
                position.current = t
                if (started.current && !stopped.current && Date.now() - last.current > REPORT_EVERY) {
                    last.current = Date.now()
                    send('progress')
                }
            },
            ended(duration: number) {
                position.current = duration || position.current
                if (started.current && !stopped.current) {
                    stopped.current = true
                    send('stop')
                }
            },
            switched() {
                if (started.current && !stopped.current) send('progress')
            },
        }
    }, [])

    useEffect(() => {
        // Closing the tab does not wait for fetch; a beacon still carries the last position.
        const onHide = () => {
            if (!started.current || stopped.current) return
            const b = reporter.body(true)
            if (!b) return
            const key = encodeURIComponent(getToken() ?? '')
            navigator.sendBeacon(
                `/emby/Sessions/Playing/Stopped?api_key=${key}`,
                new Blob([JSON.stringify(b)], { type: 'application/json' }),
            )
            // Unloading skips React's cleanup, so the transcode would run on until Emby's idle timeout.
            const s = state.current.source
            if (s && s.method !== 'DirectPlay') {
                const q = new URLSearchParams({ DeviceId: deviceId(), PlaySessionId: s.playSessionId })
                navigator.sendBeacon(`/emby/Videos/ActiveEncodings/Delete?${q}&api_key=${key}`)
            }
            stopped.current = true
        }
        window.addEventListener('pagehide', onHide)
        return () => {
            window.removeEventListener('pagehide', onHide)
            if (started.current && !stopped.current) {
                stopped.current = true
                reporter.send('stop', false, true)
            }
        }
    }, [reporter])

    return reporter
}
