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
