// What happens to the sound of a file played in the page: copied as it is when this
// browser's MSE takes it in MP4, otherwise decoded and encoded again as stereo AAC (or Opus).
// The Dolby and DTS decoders are FFmpeg builds in WebAssembly, fetched only for files that
// need them.

import type { ConversionAudioOptions, InputAudioTrack } from 'mediabunny'
import { canEncodeAudio, Quality } from 'mediabunny'

export type AudioPlan =
    | { mode: 'copy'; codec: string }
    | { mode: 'convert'; codec: string; to: 'aac' | 'opus'; channels: number; options: ConversionAudioOptions }
    | { mode: 'none'; codec: string | null }

const loaded = new Map<string, Promise<void>>()

function once(name: string, load: () => Promise<void>): Promise<void> {
    let p = loaded.get(name)
    if (!p) {
        p = load()
        loaded.set(name, p)
    }
    return p
}

const ac3 = () =>
    once('ac3', async () => {
        const m = await import('@mediabunny/ac3')
        m.registerAc3Decoder()
    })
const dts = () =>
    once('dts', async () => {
        const m = await import('@mediabunny/dts')
        m.registerDtsDecoder()
    })
const aacEncoder = () =>
    once('aac', async () => {
        const m = await import('@mediabunny/aac-encoder')
        m.registerAacEncoder()
    })

export async function planAudio(
    track: InputAudioTrack,
    supported: (type: string) => boolean,
    copyable: readonly string[],
): Promise<AudioPlan> {
    const codec = await track.getCodec()
    if (!codec) return { mode: 'none', codec: null }
    const param = await track.getCodecParameterString()
    if (param && copyable.includes(codec) && supported(`audio/mp4; codecs="${param}"`)) return { mode: 'copy', codec }

    if (codec === 'ac3' || codec === 'eac3') await ac3()
    else if (codec === 'dts') await dts()
    if (!(await track.canDecode())) return { mode: 'none', codec }

    const channels = Math.min(2, (await track.getNumberOfChannels()) || 2)
    const sampleRate = (await track.getSampleRate()) || 48_000
    const bitrate = channels > 1 ? 192_000 : 96_000
    const encodable = (c: 'aac' | 'opus') =>
        canEncodeAudio(c, { numberOfChannels: channels, sampleRate: c === 'opus' ? 48_000 : sampleRate, bitrate })
    let to: 'aac' | 'opus' | null = null
    if (supported('audio/mp4; codecs="mp4a.40.2"') && (await encodable('aac'))) to = 'aac'
    else if (supported('audio/mp4; codecs="opus"') && (await encodable('opus'))) to = 'opus'
    else if (supported('audio/mp4; codecs="mp4a.40.2"')) {
        await aacEncoder()
        if (await encodable('aac')) to = 'aac'
    }
    if (!to) return { mode: 'none', codec }
    return {
        mode: 'convert',
        codec,
        to,
        channels,
        options: {
            codec: to,
            numberOfChannels: channels,
            ...(to === 'opus' ? { sampleRate: 48_000 } : {}),
            quality: new Quality(bitrate),
            forceTranscode: true,
        },
    }
}
