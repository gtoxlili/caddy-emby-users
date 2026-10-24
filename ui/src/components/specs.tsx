import type { MediaSource, MediaStream } from '../api/types'
import { cn } from '../cn'

/** 「4K」「1080p」 from the frame height, with a little slack for cropped scope films. */
export function resolution(v: MediaStream | undefined): string {
    const h = v?.Height ?? 0
    const w = v?.Width ?? 0
    if (w >= 3200 || h >= 1800) return '4K'
    if (w >= 1800 || h >= 1000) return '1080p'
    if (w >= 1200 || h >= 700) return '720p'
    if (h > 0) return `${h}p`
    return ''
}

const CODECS: Record<string, string> = {
    h264: 'H.264',
    hevc: 'HEVC',
    h265: 'HEVC',
    av1: 'AV1',
    vp9: 'VP9',
    mpeg2video: 'MPEG-2',
    vc1: 'VC-1',
    aac: 'AAC',
    ac3: '杜比数字',
    eac3: '杜比数字+',
    truehd: 'TrueHD',
    dts: 'DTS',
    flac: 'FLAC',
    opus: 'Opus',
    mp3: 'MP3',
}

export function codecName(codec: string | undefined): string {
    if (!codec) return ''
    return CODECS[codec.toLowerCase()] ?? codec.toUpperCase()
}

/** HDR10, 杜比视界, or nothing for SDR. */
export function dynamicRange(v: MediaStream | undefined): string {
    const ext = v?.ExtendedVideoType
    if (ext && ext !== 'None') {
        if (/dolby|dovi/i.test(ext)) return '杜比视界'
        if (/hdr10plus/i.test(ext)) return 'HDR10+'
        if (/hdr/i.test(ext)) return 'HDR10'
        if (/hlg/i.test(ext)) return 'HLG'
    }
    if (v?.VideoRange && v.VideoRange !== 'SDR') return v.VideoRange
    return ''
}

function channels(s: MediaStream): string {
    const n = s.Channels ?? 0
    if (s.ChannelLayout && /\d\.\d/.test(s.ChannelLayout)) return s.ChannelLayout.match(/\d\.\d/)?.[0] ?? ''
    if (n === 1) return '单声道'
    if (n === 2) return '立体声'
    if (n === 6) return '5.1'
    if (n === 8) return '7.1'
    return n ? `${n} 声道` : ''
}

/** What a track is called on screen: its own title, else its language and format. */
export function trackName(s: MediaStream): string {
    if (s.Type === 'Audio') {
        const lang = s.DisplayLanguage || s.Language || ''
        const title = s.Title && !/^(stereo|mono|surround)$/i.test(s.Title) ? s.Title : ''
        const spec = [codecName(s.Codec), channels(s)].filter(Boolean).join(' ')
        return [title || lang || '音轨', title && /\d\.\d|ac3|dts|aac/i.test(title) ? '' : spec]
            .filter(Boolean)
            .join(' ')
    }
    const name = s.Title || s.DisplayLanguage || s.Language || s.DisplayTitle || '字幕'
    const flags = [s.IsForced && '强制', s.IsTextSubtitleStream === false && '图形'].filter(Boolean)
    return flags.length ? `${name}（${flags.join('，')}）` : name
}

function size(bytes: number | undefined): string {
    if (!bytes) return ''
    const gb = bytes / 1024 ** 3
    return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

/**
 * The projection booth's card: what the picture, the sound and the subtitles of this file
 * are. Plain rows, no chrome; it is reference, not decoration.
 */
export function Specs({ source, className }: { source: MediaSource | undefined; className?: string }) {
    if (!source) return null
    const video = source.MediaStreams.find(s => s.Type === 'Video')
    const audio = source.MediaStreams.filter(s => s.Type === 'Audio')
    const subs = source.MediaStreams.filter(s => s.Type === 'Subtitle')
    const rows: [string, string][] = []
    if (video) {
        rows.push([
            '画面',
            [
                resolution(video),
                codecName(video.Codec),
                video.BitDepth && video.BitDepth > 8 ? `${video.BitDepth} bit` : '',
                dynamicRange(video),
            ]
                .filter(Boolean)
                .join(' '),
        ])
    }
    if (audio.length) rows.push(['声音', audio.map(trackName).join('、')])
    if (subs.length) rows.push(['字幕', subs.map(trackName).join('、')])
    rows.push(['文件', [source.Container?.toUpperCase(), size(source.Size)].filter(Boolean).join('，')])
    return (
        <dl className={cn('grid grid-cols-[3em_1fr] gap-x-4 gap-y-2.5 text-[13.5px]', className)}>
            {rows.map(([k, v]) => (
                <div key={k} className="contents">
                    <dt className="text-(--text-3)">{k}</dt>
                    <dd className="m-0 text-(--text-2) text-pretty">{v}</dd>
                </div>
            ))}
        </dl>
    )
}
