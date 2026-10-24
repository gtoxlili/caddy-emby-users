import { TICKS_PER_SECOND } from './api/emby'
import type { Item } from './api/types'

export const ticksToSeconds = (ticks: number | undefined) => (ticks ?? 0) / TICKS_PER_SECOND
export const secondsToTicks = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND)

/** 1:05 / 12:34 / 1:02:03 */
export function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    const mm = h ? String(m).padStart(2, '0') : String(m)
    return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** 「42 分钟」「1 小时 58 分钟」 */
export function duration(seconds: number): string {
    const m = Math.round(seconds / 60)
    if (m < 1) return `${Math.max(1, Math.round(seconds))} 秒`
    if (m < 60) return `${m} 分钟`
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
}

/** 「1h58m」 for tight spots. */
export function shortDuration(seconds: number): string {
    const m = Math.round(seconds / 60)
    if (m < 60) return `${m} 分钟`
    return `${Math.floor(m / 60)} 小时 ${m % 60 ? `${m % 60} 分` : ''}`.trim()
}

/** The wall-clock time something started now would end: 「22:47」. */
export function endsAt(remainingSeconds: number, now = Date.now()): string {
    const d = new Date(now + remainingSeconds * 1000)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Seconds left to watch: from the resume point if there is one. */
export function remaining(it: Item): number {
    const total = ticksToSeconds(it.RunTimeTicks)
    const pos = ticksToSeconds(it.UserData?.PlaybackPositionTicks)
    return Math.max(0, total - pos)
}

/** 0–100, or 0 when there is no resume point. */
export function progressOf(it: Item): number {
    const pos = it.UserData?.PlaybackPositionTicks ?? 0
    const total = it.RunTimeTicks ?? 0
    if (pos <= 0 || total <= 0) return 0
    return Math.min(100, (pos / total) * 100)
}

/** 「第 2 季第 4 集」, 「特别篇第 1 集」, 「第 4–5 集」 */
export function episodeLabel(ep: Pick<Item, 'ParentIndexNumber' | 'IndexNumber' | 'IndexNumberEnd'>): string {
    const n = ep.IndexNumber
    const num = n === undefined ? '' : ep.IndexNumberEnd && ep.IndexNumberEnd > n ? `${n}–${ep.IndexNumberEnd}` : `${n}`
    const season = ep.ParentIndexNumber
    const head = season === 0 ? '特别篇' : season !== undefined ? `第 ${season} 季` : ''
    return num ? `${head}第 ${num} 集` : head
}

/** 「S2 E4」, for small labels. */
export function episodeCode(ep: Pick<Item, 'ParentIndexNumber' | 'IndexNumber'>): string {
    const s = ep.ParentIndexNumber
    const e = ep.IndexNumber
    if (s === undefined && e === undefined) return ''
    if (s === 0) return `SP${e ?? ''}`
    return `S${s ?? '?'} E${e ?? '?'}`
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

/** 「刚刚」「3 分钟前」「昨天」「3月2日」 */
export function relative(iso: string | undefined, now = Date.now()): string {
    if (!iso) return ''
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return ''
    const diff = (t - now) / 1000
    const abs = Math.abs(diff)
    if (abs < 45) return '刚刚'
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
    if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
    const d = new Date(t)
    const sameYear = d.getFullYear() === new Date(now).getFullYear()
    return d.toLocaleDateString(
        'zh-CN',
        sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' },
    )
}

export function dateTime(iso: string | undefined): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
}

/** 「2010」 or 「2008–2013」 for a series that ended. */
export function years(it: Item): string {
    const start = it.ProductionYear ?? (it.PremiereDate ? new Date(it.PremiereDate).getFullYear() : undefined)
    if (!start) return ''
    if (it.Type === 'Series') {
        if (it.Status === 'Continuing') return `${start}–`
        const end = it.EndDate ? new Date(it.EndDate).getFullYear() : undefined
        if (end && end !== start) return `${start}–${end}`
    }
    return String(start)
}

export function greeting(): string {
    const h = new Date().getHours()
    if (h < 5) return '夜深了'
    if (h < 11) return '早上好'
    if (h < 14) return '中午好'
    if (h < 18) return '下午好'
    return '晚上好'
}
