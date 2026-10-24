// The <video> element's state as React state. One snapshot object per change; components
// read what they need from it.

import { useEffect, useState } from 'react'

export interface MediaState {
    paused: boolean
    ended: boolean
    waiting: boolean
    /** Has shown a frame at least once. */
    started: boolean
    currentTime: number
    duration: number
    buffered: number
    volume: number
    muted: boolean
    rate: number
    fullscreen: boolean
    pip: boolean
    airplay: boolean
}

const EVENTS = [
    'play',
    'pause',
    'playing',
    'waiting',
    'seeking',
    'seeked',
    'ended',
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'progress',
    'volumechange',
    'ratechange',
    'canplay',
    'enterpictureinpicture',
    'leavepictureinpicture',
    'emptied',
] as const

function bufferedEnd(v: HTMLVideoElement): number {
    const b = v.buffered
    for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i)
    }
    return v.currentTime
}

/** `fallbackDuration` covers streams whose length the element cannot know up front. */
export function useMediaState(video: HTMLVideoElement | null, fallbackDuration: number) {
    const [state, setState] = useState<MediaState>({
        paused: true,
        ended: false,
        waiting: false,
        started: false,
        currentTime: 0,
        duration: fallbackDuration,
        buffered: 0,
        volume: 1,
        muted: false,
        rate: 1,
        fullscreen: false,
        pip: false,
        airplay: false,
    })
    useEffect(() => {
        if (!video) return
        let waiting = false
        let started = false
        let airplay = false
        const read = (e?: Event) => {
            if (e?.type === 'waiting' || e?.type === 'seeking') waiting = true
            if (e?.type === 'playing' || e?.type === 'seeked' || e?.type === 'canplay' || e?.type === 'pause')
                waiting = false
            if (e?.type === 'playing') started = true
            if (e?.type === 'emptied') started = false
            const d = video.duration
            setState({
                paused: video.paused,
                ended: video.ended,
                waiting,
                started,
                currentTime: video.currentTime,
                duration: Number.isFinite(d) && d > 0 ? d : fallbackDuration,
                buffered: bufferedEnd(video),
                volume: video.volume,
                muted: video.muted,
                rate: video.playbackRate,
                fullscreen:
                    !!document.fullscreenElement ||
                    !!(video as { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen,
                pip: document.pictureInPictureElement === video,
                airplay,
            })
        }
        const onAirplay = (e: Event) => {
            airplay = (e as Event & { availability?: string }).availability === 'available'
            read()
        }
        for (const ev of EVENTS) video.addEventListener(ev, read)
        video.addEventListener('webkitplaybacktargetavailabilitychanged', onAirplay)
        video.addEventListener('webkitbeginfullscreen', read)
        video.addEventListener('webkitendfullscreen', read)
        document.addEventListener('fullscreenchange', read)
        read()
        return () => {
            for (const ev of EVENTS) video.removeEventListener(ev, read)
            video.removeEventListener('webkitplaybacktargetavailabilitychanged', onAirplay)
            video.removeEventListener('webkitbeginfullscreen', read)
            video.removeEventListener('webkitendfullscreen', read)
            document.removeEventListener('fullscreenchange', read)
        }
    }, [video, fallbackDuration])
    return state
}

/** Fullscreen on the stage, so the controls and subtitles come along; iPhone only lets the video itself go fullscreen. */
export function toggleFullscreen(stage: HTMLElement | null, video: HTMLVideoElement | null) {
    if (document.fullscreenElement) {
        void document.exitFullscreen()
        return
    }
    if (stage?.requestFullscreen) {
        stage
            .requestFullscreen({ navigationUI: 'hide' })
            .then(() => {
                // Android Chrome turns sideways for a film once fullscreen allows it.
                const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
                if (video && video.videoWidth > video.videoHeight) o.lock?.('landscape').catch(() => {})
            })
            .catch(() => {})
        return
    }
    const v = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    v?.webkitEnterFullscreen?.()
}
