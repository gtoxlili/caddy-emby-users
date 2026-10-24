// Text subtitle payloads as stored in Matroska, turned into WebVTT cue text. Italic, bold and
// underline survive; positioning, colours and effects do not, so every line reads alike.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** SubRip text: HTML-ish tags, sometimes with ASS override blocks left in. */
export function subripCue(raw: string): string | null {
    const text = raw
        .replace(/\r\n?/g, '\n')
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
    let out = ''
    for (const part of text.split(/(<[^>]*>)/)) {
        if (!part.startsWith('<')) out += esc(part)
        else {
            const m = /^<\s*(\/?)\s*([biu])\s*>$/i.exec(part)
            if (m) out += `<${m[1]}${(m[2] as string).toLowerCase()}>`
        }
    }
    return out.trim() || null
}

/**
 * One ASS/SSA event as Matroska stores it: ReadOrder, Layer, Style, Name, MarginL, MarginR,
 * MarginV, Effect, Text.
 */
export function assCue(raw: string): string | null {
    const text = afterCommas(raw, 8)
    return text === null ? null : assText(text)
}

/** What follows the n-th comma, or null when there are fewer. */
function afterCommas(raw: string, n: number): string | null {
    let at = -1
    for (let k = 0; k < n; k++) {
        at = raw.indexOf(',', at + 1)
        if (at < 0) return null
    }
    return raw.slice(at + 1)
}

/** The Text field of an ASS event. Vector drawings are left out. */
export function assText(text: string): string | null {
    if (/\{[^}]*\\p[1-9]/.test(text)) return null
    let out = ''
    let last = 0
    for (const m of text.matchAll(/\{([^}]*)\}/g)) {
        out += esc(text.slice(last, m.index))
        last = (m.index ?? 0) + m[0].length
        for (const tag of (m[1] ?? '').matchAll(/\\([biu])(\d+)/g)) {
            out += tag[2] === '0' ? `</${tag[1]}>` : `<${tag[1]}>`
        }
    }
    out += esc(text.slice(last))
    return (
        out
            .replace(/\\[Nn]/g, '\n')
            .replace(/\\h/g, '\u00a0')
            .replace(/[ \t]*\n[ \t]*/g, '\n')
            .trim() || null
    )
}

// ---- whole subtitle files, for those a server sends as they are ----

const vttTime = (s: number) => {
    const ms = Math.round(s * 1000)
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor(ms / 60_000) % 60
    const sec = Math.floor(ms / 1000) % 60
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`
}

/** 1:02:03.45 (ASS) or 01:02:03,456 (SRT) in seconds. */
function seconds(t: string): number | null {
    const m = /(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?/.exec(t)
    if (!m) return null
    const frac = m[4] ? Number(`0.${m[4]}`) : 0
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac
}

function vtt(cues: { start: number; end: number; text: string }[]): string {
    cues.sort((a, b) => a.start - b.start)
    const body = cues.map(c => {
        const text = c.text.replace(/\n{2,}/g, '\n').replace(/-->/g, '--&gt;')
        return `${vttTime(c.start)} --> ${vttTime(c.end)}\n${text}`
    })
    return `WEBVTT\n\n${body.join('\n\n')}\n`
}

/**
 * A subtitle file as WebVTT. Some servers convert on request, some send the original
 * whatever the extension asked for; ASS and SubRip are converted here, WebVTT passes.
 */
export function toVtt(raw: string): string {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    if (/^WEBVTT/.test(text)) return text
    const cues: { start: number; end: number; text: string }[] = []
    if (/^\s*\[(Script Info|V4\+? Styles|Events)\]/im.test(text)) {
        let format: string[] = []
        for (const line of text.split('\n')) {
            const f = /^Format:\s*(.*)$/i.exec(line)
            if (f) format = (f[1] ?? '').split(',').map(x => x.trim().toLowerCase())
            const d = /^Dialogue:\s*(.*)$/i.exec(line)
            if (!d || !format.length) continue
            const body = d[1] ?? ''
            const textAt = format.indexOf('text')
            const fields = body.split(',', textAt)
            const start = seconds(fields[format.indexOf('start')] ?? '')
            const end = seconds(fields[format.indexOf('end')] ?? '')
            const cueText = assText(afterCommas(body, textAt) ?? '')
            if (start !== null && end !== null && end > start && cueText) cues.push({ start, end, text: cueText })
        }
        return vtt(cues)
    }
    for (const block of text.split(/\n{2,}/)) {
        const lines = block.split('\n')
        const at = lines.findIndex(l => l.includes('-->'))
        if (at < 0) continue
        const [a, b] = (lines[at] as string).split('-->')
        const start = seconds(a ?? '')
        const end = seconds(b ?? '')
        const cueText = subripCue(lines.slice(at + 1).join('\n'))
        if (start !== null && end !== null && cueText) cues.push({ start, end, text: cueText })
    }
    return vtt(cues)
}
