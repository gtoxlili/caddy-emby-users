// Puts a source into the <video> element. Files the browser plays as they are go straight
// into src. HLS goes through hls.js on MSE, except on Safari, whose own HLS is better
// (AirPlay works only with it) and on iOS the only choice that survives the lock screen.

import type Hls from 'hls.js'
import type { Source } from './source'

export interface Engine {
    destroy(): void
}

const SAFARI =
    typeof navigator !== 'undefined' && /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)
const IOS =
    typeof navigator !== 'undefined' &&
    (/iP(hone|ad|od)/.test(navigator.userAgent) ||
        (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

export type FatalKind = 'network' | 'decode' | 'unsupported'

/** Seeks to start once the element knows its duration; some browsers ignore an earlier currentTime. */
function seekOnLoad(video: HTMLVideoElement, start: number) {
    if (start <= 0) return
    const go = () => {
        if (Math.abs(video.currentTime - start) > 1) video.currentTime = start
    }
    if (video.readyState >= 1) go()
    else video.addEventListener('loadedmetadata', go, { once: true })
}

export async function attach(
    video: HTMLVideoElement,
    source: Source,
    start: number,
    onFatal: (kind: FatalKind) => void,
): Promise<Engine> {
    const native = !source.hls || ((SAFARI || IOS) && video.canPlayType('application/vnd.apple.mpegurl') !== '')
    if (native) {
        video.src = source.url
        seekOnLoad(video, start)
        return {
            destroy() {
                video.removeAttribute('src')
                video.load()
            },
        }
    }
    const { default: HlsLib } = await import('hls.js')
    if (!HlsLib.isSupported()) {
        onFatal('unsupported')
        return { destroy() {} }
    }
    const hls: Hls = new HlsLib({
        startPosition: start > 0 ? start : -1,
        // The server transcodes ahead on demand; a minute of buffer rides out a slow segment
        // without making it encode far past where the person is watching.
        maxBufferLength: 60,
        backBufferLength: 60,
        enableWorker: true,
    })
    let mediaRecovered = false
    hls.on(HlsLib.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
            mediaRecovered = true
            hls.recoverMediaError()
            return
        }
        onFatal(data.type === HlsLib.ErrorTypes.NETWORK_ERROR ? 'network' : 'decode')
    })
    hls.loadSource(source.url)
    hls.attachMedia(video)
    return {
        destroy() {
            hls.destroy()
            video.removeAttribute('src')
            video.load()
        },
    }
}

export { IOS, SAFARI }
