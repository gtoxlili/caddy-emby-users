// Subtitles read out of the file in the page go into TextTracks added to the <video>. An
// element cannot drop such a track again, so each subtitle stream gets one for the whole
// visit, and a later source of the same film fills the same track.

interface LocalTrack {
    track: TextTrack
    /** Cues already added, so reading a stretch of the file twice adds nothing twice. */
    seen: Set<string>
}

const byVideo = new WeakMap<HTMLVideoElement, Map<number, LocalTrack>>()

export function localTrack(video: HTMLVideoElement, index: number, label: string, lang: string): LocalTrack {
    let tracks = byVideo.get(video)
    if (!tracks) {
        tracks = new Map()
        byVideo.set(video, tracks)
    }
    let t = tracks.get(index)
    if (!t) {
        const track = video.addTextTrack('subtitles', label, lang)
        track.mode = 'disabled'
        t = { track, seen: new Set() }
        tracks.set(index, t)
    }
    return t
}

export function findLocalTrack(video: HTMLVideoElement, index: number): TextTrack | undefined {
    return byVideo.get(video)?.get(index)?.track
}
