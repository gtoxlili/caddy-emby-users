// Turns the server's PlaybackInfo answer into something the media element can load, and
// says honestly how it will play. In order of preference: the file as it is; the file
// remuxed by the page itself (MKV, Dolby or DTS sound, embedded subtitles); a stream the
// server remuxes or transcodes. Some servers only ever offer the file, so the page has to
// cope with whatever is in it.

import { getToken, serverUrl } from '../api/client'
import type { PlayMethod } from '../api/emby'
import { capabilities, localAudio, localVideo, nativeAudio } from '../api/profile'
import type { MediaSource, MediaStream, PlaybackInfo } from '../api/types'
import { codecName } from '../components/specs'
import { ANDROID, IOS } from './engine'

export interface TextTrack {
    index: number
    label: string
    lang: string
    url: string
}

/** file: the element plays the file. local: the page remuxes it. hls: the server streams it. */
export type Delivery = 'file' | 'local' | 'hls'

export interface Source {
    url: string
    delivery: Delivery
    /** What Emby is told: the page remuxing a file it was sent as is still plays it directly. */
    method: PlayMethod
    media: MediaSource
    playSessionId: string
    /** The audio stream that plays; may differ from the one asked for when that one cannot. */
    audio: number | undefined
    /** Subtitles the server sends as WebVTT. */
    tracks: TextTrack[]
    /** Embedded subtitle streams, in file order; a local source reads them out of the file. */
    embedded: MediaStream[]
    /** The subtitle the server burns into the picture, if any. */
    burnedIn: number | null
    /** Why the server is not sending the file as it is. */
    reasons: string[]
    /** What the page does to the file itself. */
    notes: string[]
    /** Something the person should hear about when playback starts. */
    warning: string | null
    /**
     * Set when the page could not play the file itself and handed it to the browser's own
     * player on the chance that it copes: why the page could not.
     */
    guess: string | null
}

export class NoStream extends Error {
    readonly code: string
    /** Why, in words, when the page knows. */
    readonly detail: string | null
    constructor(code: string, detail: string | null = null) {
        super(code)
        this.code = code
        this.detail = detail
    }
}

const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'mov'])
const LOCAL_CONTAINERS = new Set(['mkv', 'matroska', 'webm', 'mp4', 'm4v', 'mov', 'ts', 'mpegts', 'm2ts'])

const channelsName = (s: MediaStream) =>
    s.Channels === 8 ? '7.1' : s.Channels === 6 ? '5.1' : s.Channels === 2 ? '立体声' : s.Channels === 1 ? '单声道' : ''

/** How the page shows an embedded subtitle stream when it reads the file itself, if it can. */
export function embyKind(s: MediaStream): 'text' | 'bitmap' | null {
    const c = (s.Codec ?? '').toLowerCase()
    if (['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'vtt'].includes(c)) return 'text'
    if (c === 'pgssub' || c === 'pgs' || c === 'hdmv_pgs_subtitle') return 'bitmap'
    return null
}

/**
 * The audio stream to play: the one asked for, else the file's default. When the page cannot
 * play that one (TrueHD), another it can play, preferring the same language.
 */
function pickAudio(
    media: MediaSource,
    wanted: number | undefined,
): { stream: MediaStream | undefined; note: string | null } {
    const audios = media.MediaStreams.filter(s => s.Type === 'Audio')
    const asked =
        audios.find(s => s.Index === wanted) ??
        audios.find(s => s.Index === media.DefaultAudioStreamIndex) ??
        audios.find(s => s.IsDefault) ??
        audios[0]
    const playable = (s: MediaStream) => nativeAudio(s.Codec) || localAudio(s.Codec) !== null
    if (!asked || playable(asked)) return { stream: asked, note: null }
    const other = audios.find(s => playable(s) && s.Language === asked.Language) ?? audios.find(playable)
    const name = codecName(asked.Codec) || asked.Codec || '这条音轨'
    return other
        ? { stream: other, note: `${name} 音轨浏览器放不了，换成了另一条` }
        : { stream: asked, note: `${name} 音轨浏览器放不了，只有画面` }
}

function staticUrl(itemId: string, media: MediaSource, playSessionId: string): string {
    const q = new URLSearchParams({
        Static: 'true',
        MediaSourceId: media.Id,
        PlaySessionId: playSessionId,
        api_key: getToken() ?? '',
    })
    return `/emby/Videos/${itemId}/stream.${(media.Container ?? 'mp4').split(',')[0]}?${q}`
}

export function chooseSource(info: PlaybackInfo, itemId: string, want: { audio?: number; subtitle?: number }): Source {
    if (info.ErrorCode) throw new NoStream(info.ErrorCode)
    const media = info.MediaSources[0]
    if (!media) throw new NoStream('NoCompatibleStream')
    const token = encodeURIComponent(getToken() ?? '')
    // Every text subtitle comes as WebVTT from Emby's converter, whatever PlaybackInfo
    // decided: left to itself, Emby 4.10 burns embedded ASS into a full transcode.
    const tracks: TextTrack[] = media.MediaStreams.filter(s => s.Type === 'Subtitle' && isTextSubtitle(s)).map(s => ({
        index: s.Index,
        label: s.Title || s.DisplayLanguage || s.DisplayTitle || `字幕 ${s.Index}`,
        lang: s.Language ?? '',
        url:
            s.DeliveryMethod === 'External' && s.DeliveryUrl
                ? serverUrl(s.DeliveryUrl)
                : `/emby/Videos/${itemId}/${encodeURIComponent(media.Id)}/Subtitles/${s.Index}/0/Stream.vtt?api_key=${token}`,
    }))
    const embedded = media.MediaStreams.filter(s => s.Type === 'Subtitle' && !s.IsExternal)
    const transcoding = media.TranscodingUrl ? serverUrl(media.TranscodingUrl) : null
    const burnedIn = transcoding ? subtitleInUrl(transcoding) : null
    const { stream: audio, note: audioNote } = pickAudio(media, want.audio)
    const base = {
        media,
        playSessionId: info.PlaySessionId,
        audio: audio?.Index,
        burnedIn: null,
        reasons: [],
        warning: null,
        guess: null,
    }

    let refusal: string | null = null
    if (media.SupportsDirectPlay && !(want.subtitle !== undefined && burnedIn === want.subtitle)) {
        const container = (media.Container ?? '').split(',')[0]?.toLowerCase() ?? ''
        const picture = media.MediaStreams.find(s => s.Type === 'Video')
        const audios = media.MediaStreams.filter(s => s.Type === 'Audio')
        const isDefault = !audio || audio === (audios.find(s => s.IsDefault) ?? audios[0])
        const c = capabilities()
        const deep = (picture?.BitDepth ?? 8) > 8
        const pictureNative =
            !picture ||
            (picture.Codec === 'h264' && !deep) ||
            (picture.Codec === 'hevc' && (deep ? c.hevc10 : c.hevc)) ||
            (picture.Codec === 'av1' && (deep ? c.av1_10 : c.av1)) ||
            (picture.Codec === 'vp9' && c.vp9)
        // The element plays only the file's default audio track; another one needs the page.
        if (NATIVE_CONTAINERS.has(container) && pictureNative && (!audio || nativeAudio(audio.Codec)) && isDefault) {
            return {
                ...base,
                url: staticUrl(itemId, media, info.PlaySessionId),
                delivery: 'file',
                method: 'DirectPlay',
                tracks,
                embedded,
                notes: [],
            }
        }
        if (!c.local) {
            refusal = IOS
                ? '这台 iPhone 的系统低于 iOS 17.1，网页里没有播放这种文件要用的 MSE。'
                : ANDROID
                  ? '这个浏览器关掉了网页播放要用的 MSE，手机自带的浏览器和 App 里的浏览器常这样。'
                  : '这个浏览器没有网页播放要用的 MSE。'
        } else if (!LOCAL_CONTAINERS.has(container)) {
            refusal = `浏览器打不开 ${container.toUpperCase() || '这种'} 封装的文件。`
        } else if (picture && !localVideo(picture)) {
            refusal = `这个浏览器解不了 ${codecName(picture.Codec) || picture.Codec}${(picture.BitDepth ?? 8) > 8 ? ' 10 bit' : ''} 画面。`
        } else {
            const notes = [
                NATIVE_CONTAINERS.has(container)
                    ? '浏览器读取原文件'
                    : `${container.toUpperCase()} 文件由浏览器读取、重新封装`,
                '画面不重新编码',
            ]
            const how = audio ? localAudio(audio.Codec) : null
            if (audio && how === 'convert') {
                const name = [codecName(audio.Codec), channelsName(audio)].filter(Boolean).join(' ')
                notes.push(`声音 ${name} 在浏览器里转成立体声`)
            }
            if (audioNote) notes.push(audioNote)
            return {
                ...base,
                url: staticUrl(itemId, media, info.PlaySessionId),
                delivery: 'local',
                method: 'DirectPlay',
                // Subtitles inside the file come out of the file; only external ones from the server.
                tracks: tracks.filter(t => media.MediaStreams.find(s => s.Index === t.index)?.IsExternal),
                embedded,
                notes,
                warning: audioNote,
            }
        }
    }
    if (!transcoding && refusal) {
        // Nothing the page can do and nothing from the server: the browser's own player gets
        // the file as it is. Android browsers that hide MSE hand video to the phone's player,
        // which often plays MKV and Dolby sound; when it cannot, the error says why.
        const audios = media.MediaStreams.filter(s => s.Type === 'Audio')
        return {
            ...base,
            url: staticUrl(itemId, media, info.PlaySessionId),
            delivery: 'file',
            method: 'DirectPlay',
            audio: (audios.find(s => s.IsDefault) ?? audios[0])?.Index,
            tracks,
            embedded,
            notes: ['网页没法自己处理这个文件，交给浏览器自带的播放器'],
            guess: refusal,
        }
    }
    if (!transcoding) throw new NoStream('NoCompatibleStream', refusal)
    const reasons = transcodeReasons(transcoding)
    // Only the container in the way: the server copies picture and sound into HLS segments.
    const remux = reasons.length > 0 && reasons.every(r => r === 'ContainerNotSupported')
    return {
        ...base,
        url: transcoding,
        delivery: 'hls',
        method: remux ? 'DirectStream' : 'Transcode',
        audio: want.audio ?? media.DefaultAudioStreamIndex,
        tracks,
        embedded,
        burnedIn,
        reasons,
        notes: [],
    }
}

function param(url: string, key: string): string | null {
    const q = url.split('?')[1] ?? ''
    for (const [k, v] of new URLSearchParams(q)) if (k.toLowerCase() === key) return v
    return null
}

function subtitleInUrl(url: string): number | null {
    const v = param(url, 'subtitlestreamindex')
    const method = param(url, 'subtitlemethod')
    if (v === null || Number(v) < 0 || (method && method.toLowerCase() !== 'encode')) return null
    return Number(v)
}

function transcodeReasons(url: string): string[] {
    return (param(url, 'transcodereasons') ?? '').split(',').filter(Boolean)
}

const REASONS: Record<string, string> = {
    ContainerNotSupported: '这个浏览器不支持文件的封装格式',
    VideoCodecNotSupported: '这个浏览器解不了画面的编码',
    AudioCodecNotSupported: '这个浏览器解不了声音的编码',
    VideoProfileNotSupported: '画面编码的规格这里解不了',
    VideoBitDepthNotSupported: '画面是 10 bit，这里解不了',
    VideoLevelNotSupported: '画面编码的级别太高',
    VideoRangeTypeNotSupported: '这里显示不了这种 HDR',
    InterlacedVideoNotSupported: '画面是隔行扫描的，需要去隔行',
    AudioChannelsNotSupported: '声道太多，混成立体声',
    SubtitleCodecNotSupported: '字幕要烧进画面',
    ContainerBitrateExceedsLimit: '码率超过了选的画质',
    VideoBitrateNotSupported: '码率超过了选的画质',
    AudioBitrateNotSupported: '声音码率超过了上限',
    DirectPlayError: '直接播放出错了',
}

/** How this source plays and why, in words, for the settings menu. */
export function describeSource(source: Source): string[] {
    const how =
        source.delivery === 'file'
            ? '直接播放原文件'
            : source.delivery === 'local'
              ? '浏览器自己转封装'
              : source.method === 'DirectStream'
                ? '服务器转封装，画面和声音不重新编码'
                : '服务器转码中'
    return [how, ...source.reasons.map(r => REASONS[r] ?? r), ...source.notes]
}

const TEXT_CODECS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'text', 'smi', 'sami', 'ttml'])

/** Text subtitles can be drawn by the page; image ones (PGS, VobSub) have to be burned in. */
export function isTextSubtitle(s: MediaStream): boolean {
    return s.IsTextSubtitleStream ?? TEXT_CODECS.has((s.Codec ?? '').toLowerCase())
}

/** The audio and subtitle streams a person can choose from. */
export function streamsOf(media: MediaSource | undefined, type: 'Audio' | 'Subtitle'): MediaStream[] {
    return (media?.MediaStreams ?? []).filter(s => s.Type === type)
}
