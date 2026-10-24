import { useEffect, useRef } from 'react'

const W = 32
const H = 18
const EVERY = 220

/**
 * The film lights the room it plays in: a tiny copy of the current frame, scaled up and
 * blurred behind the picture, glows wherever the picture does not reach (letterbox bars, a
 * window shaped unlike the film). Two canvases crossfade so the glow drifts instead of
 * flickering. Drawing a frame only works for same-origin video, which every stream here is.
 */
export function Ambilight({ video, on }: { video: HTMLVideoElement | null; on: boolean }) {
    const a = useRef<HTMLCanvasElement>(null)
    const b = useRef<HTMLCanvasElement>(null)
    useEffect(() => {
        if (!video || !on) return
        let front = 0
        let timer: ReturnType<typeof setInterval> | null = null
        const draw = () => {
            const canvas = front === 0 ? b.current : a.current
            const other = front === 0 ? a.current : b.current
            const ctx = canvas?.getContext('2d', { willReadFrequently: false })
            if (!canvas || !other || !ctx || video.readyState < 2) return
            try {
                ctx.drawImage(video, 0, 0, W, H)
            } catch {
                return
            }
            canvas.style.opacity = '1'
            other.style.opacity = '0'
            front = 1 - front
        }
        const start = () => {
            if (!timer) timer = setInterval(draw, EVERY)
        }
        const stop = () => {
            if (timer) clearInterval(timer)
            timer = null
            draw()
        }
        video.addEventListener('play', start)
        video.addEventListener('pause', stop)
        video.addEventListener('seeked', draw)
        video.addEventListener('loadeddata', draw)
        if (!video.paused) start()
        else draw()
        return () => {
            video.removeEventListener('play', start)
            video.removeEventListener('pause', stop)
            video.removeEventListener('seeked', draw)
            video.removeEventListener('loadeddata', draw)
            if (timer) clearInterval(timer)
        }
    }, [video, on])
    if (!on) return null
    const cls =
        'absolute inset-0 size-full scale-110 opacity-0 blur-[48px] saturate-150 transition-opacity duration-[900ms] ease-linear'
    return (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden opacity-70">
            <canvas ref={a} width={W} height={H} className={cls} />
            <canvas ref={b} width={W} height={H} className={cls} />
        </div>
    )
}
