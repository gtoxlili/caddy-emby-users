// The controls over the picture: the title along the top, a capsule of glass along the
// bottom with the timeline above the buttons. While the film plays they leave, and only a
// hairline of progress stays at the bottom edge.

import {
    Airplay,
    ArrowLeft,
    AudioLines,
    Captions as CaptionsIcon,
    ListVideo,
    Maximize,
    Minimize,
    Pause,
    PictureInPicture2,
    Play,
    RotateCcw,
    RotateCw,
    Settings2,
    SkipForward,
    Volume1,
    Volume2,
    VolumeX,
} from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { forwardRef } from 'react'
import type { Chapter } from '../api/types'
import { cn } from '../cn'
import { clock } from '../format'
import { Spinner } from '../ui/spinner'
import type { MediaState } from './media'
import type { Option } from './menus'
import { Choices, MenuNote, MenuSeparator, MenuToggle, PlayerMenu } from './menus'
import { SeekBar } from './seek'

export const btn =
    'grid size-10 shrink-0 place-items-center rounded-full text-white/92 outline-none transition-[background-color,transform] duration-200 hover:bg-white/12 active:scale-95 disabled:pointer-events-none disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-(--accent)'

const IconButton = forwardRef<
    HTMLButtonElement,
    { label: string; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function IconButton({ label, children, className, ...rest }, ref) {
    return (
        <button ref={ref} type="button" aria-label={label} title={label} className={cn(btn, className)} {...rest}>
            {children}
        </button>
    )
})

export interface ControlsProps {
    stage: RefObject<HTMLElement | null>
    visible: boolean
    mobile: boolean
    title: ReactNode
    subtitle?: ReactNode
    media: MediaState
    itemId: string
    chapters: Chapter[] | undefined
    hasNext: boolean
    hasEpisodes: boolean
    canPip: boolean
    audio: { value: string; options: Option[]; onChange: (v: string) => void }
    subtitles: { value: string; options: Option[]; onChange: (v: string) => void }
    quality: { value: string; options: Option[]; onChange: (v: string) => void }
    rate: { value: string; options: Option[]; onChange: (v: string) => void }
    ambilight: { on: boolean; onChange: (v: boolean) => void } | null
    info: string[]
    onBack: () => void
    onPlay: () => void
    onSeek: (t: number) => void
    onSkip: (delta: number) => void
    onNext: () => void
    onEpisodes: () => void
    onVolume: (v: number) => void
    onMute: () => void
    onFullscreen: () => void
    onPip: () => void
    onAirplay: () => void
    onMenu: (open: boolean) => void
    onScrub: (active: boolean) => void
    onHoverControls: (inside: boolean) => void
}

export function Controls(p: ControlsProps) {
    const m = p.media
    const pct = m.duration > 0 ? (m.currentTime / m.duration) * 100 : 0
    const left = Math.max(0, m.duration - m.currentTime)
    return (
        <>
            {/* The hairline that stays while the controls are away. */}
            <div
                className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 z-[6] h-[2px] bg-white/12 transition-opacity duration-300',
                    p.visible || m.paused ? 'opacity-0' : 'opacity-100',
                )}
            >
                <div className="h-full bg-white/80" style={{ width: `${pct}%` }} />
            </div>

            {m.waiting && !m.paused && (
                <div className="pointer-events-none absolute inset-0 z-[6] grid place-items-center">
                    <Spinner className="size-10 text-white/85" />
                </div>
            )}
            {m.paused && !m.ended && m.started && !m.waiting && (
                <div className="pointer-events-none absolute inset-0 z-[6] grid place-items-center">
                    <button
                        type="button"
                        aria-label="播放"
                        onClick={p.onPlay}
                        className="glass glass-dim pointer-events-auto grid size-[84px] place-items-center rounded-full text-white transition-transform duration-300 ease-(--ease-spring) hover:scale-105 active:scale-95"
                    >
                        <Play className="ml-1 size-9 fill-current" />
                    </button>
                </div>
            )}

            <div
                className={cn(
                    'pointer-events-none absolute inset-0 z-20 flex flex-col justify-between transition-opacity duration-300',
                    p.visible ? 'opacity-100' : 'opacity-0',
                )}
            >
                <div
                    className={cn(
                        'flex items-start gap-3 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pt-[max(12px,env(safe-area-inset-top))] pb-14 md:px-6 md:pt-5',
                        p.visible && 'pointer-events-auto',
                    )}
                    onPointerEnter={() => p.onHoverControls(true)}
                    onPointerLeave={() => p.onHoverControls(false)}
                >
                    <IconButton label="返回" onClick={p.onBack}>
                        <ArrowLeft className="size-[22px]" strokeWidth={2.2} />
                    </IconButton>
                    <div className="min-w-0 flex-1 pt-1">
                        <div className="truncate text-[16px] leading-tight font-semibold text-white md:text-[18px]">
                            {p.title}
                        </div>
                        {p.subtitle && (
                            <div className="mt-1 truncate text-[13px] leading-tight text-white/70 tabular">
                                {p.subtitle}
                            </div>
                        )}
                    </div>
                    {p.hasEpisodes && (
                        <IconButton label="选集" onClick={p.onEpisodes}>
                            <ListVideo className="size-[22px]" strokeWidth={2.1} />
                        </IconButton>
                    )}
                </div>

                <div
                    className={cn(
                        'px-2 pb-[max(10px,env(safe-area-inset-bottom))] md:px-6 md:pb-6',
                        p.visible && 'pointer-events-auto',
                    )}
                    onPointerEnter={() => p.onHoverControls(true)}
                    onPointerLeave={() => p.onHoverControls(false)}
                >
                    <div className="glass glass-dim mx-auto max-w-[1180px] rounded-[26px] px-3 pt-1.5 pb-2 md:px-5 md:pt-2.5 md:pb-3">
                        <div className="flex items-center gap-3">
                            <span className="w-[5.2ch] shrink-0 text-right text-[12.5px] text-white/90 tabular">
                                {clock(m.currentTime)}
                            </span>
                            <SeekBar
                                itemId={p.itemId}
                                chapters={p.chapters}
                                currentTime={m.currentTime}
                                duration={m.duration}
                                buffered={m.buffered}
                                onSeek={p.onSeek}
                                onScrub={p.onScrub}
                            />
                            <span className="w-[5.8ch] shrink-0 text-[12.5px] text-white/55 tabular">
                                -{clock(left)}
                            </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-0.5 md:gap-1">
                            <IconButton label={m.paused ? '播放' : '暂停'} onClick={p.onPlay}>
                                {m.paused ? (
                                    <Play className="ml-0.5 size-[22px] fill-current" />
                                ) : (
                                    <Pause className="size-[22px] fill-current" />
                                )}
                            </IconButton>
                            {!p.mobile && (
                                <>
                                    <IconButton label="后退 10 秒" onClick={() => p.onSkip(-10)}>
                                        <RotateCcw className="size-5" />
                                    </IconButton>
                                    <IconButton label="快进 10 秒" onClick={() => p.onSkip(10)}>
                                        <RotateCw className="size-5" />
                                    </IconButton>
                                </>
                            )}
                            {p.hasNext && (
                                <IconButton label="下一集" onClick={p.onNext}>
                                    <SkipForward className="size-5 fill-current" />
                                </IconButton>
                            )}
                            {!p.mobile && <Volume media={m} onVolume={p.onVolume} onMute={p.onMute} />}
                            <span className="flex-1" />
                            {p.subtitles.options.length > 1 && (
                                <PlayerMenu
                                    container={p.stage}
                                    onOpenChange={p.onMenu}
                                    trigger={
                                        <IconButton
                                            label="字幕"
                                            className={p.subtitles.value !== 'off' ? 'text-(--accent)' : undefined}
                                        >
                                            <CaptionsIcon className="size-[21px]" />
                                        </IconButton>
                                    }
                                >
                                    <Choices label="字幕" {...p.subtitles} />
                                </PlayerMenu>
                            )}
                            {p.audio.options.length > 1 && (
                                <PlayerMenu
                                    container={p.stage}
                                    onOpenChange={p.onMenu}
                                    trigger={
                                        <IconButton label="音轨">
                                            <AudioLines className="size-5" />
                                        </IconButton>
                                    }
                                >
                                    <Choices label="音轨" {...p.audio} />
                                </PlayerMenu>
                            )}
                            <PlayerMenu
                                container={p.stage}
                                onOpenChange={p.onMenu}
                                trigger={
                                    <button
                                        type="button"
                                        aria-label="倍速"
                                        title="倍速"
                                        className={cn(btn, 'w-auto px-2.5 text-[13.5px] font-semibold tabular')}
                                    >
                                        {p.rate.value === '1' ? '1×' : `${p.rate.value}×`}
                                    </button>
                                }
                                className="min-w-[150px]"
                            >
                                <Choices label="倍速" {...p.rate} />
                            </PlayerMenu>
                            <PlayerMenu
                                container={p.stage}
                                onOpenChange={p.onMenu}
                                trigger={
                                    <IconButton label="画质与播放">
                                        <Settings2 className="size-5" />
                                    </IconButton>
                                }
                                className="w-[268px]"
                            >
                                <Choices label="画质" {...p.quality} />
                                {p.ambilight && (
                                    <>
                                        <MenuSeparator />
                                        <MenuToggle
                                            label="氛围光"
                                            checked={p.ambilight.on}
                                            onChange={p.ambilight.onChange}
                                        />
                                    </>
                                )}
                                {p.info.length > 0 && (
                                    <>
                                        <MenuSeparator />
                                        {p.info.map(line => (
                                            <MenuNote key={line}>{line}</MenuNote>
                                        ))}
                                    </>
                                )}
                            </PlayerMenu>
                            {m.airplay && (
                                <IconButton label="隔空播放" onClick={p.onAirplay}>
                                    <Airplay className="size-5" />
                                </IconButton>
                            )}
                            {p.canPip && (
                                <IconButton label={m.pip ? '退出小窗' : '小窗播放'} onClick={p.onPip}>
                                    <PictureInPicture2 className="size-5" />
                                </IconButton>
                            )}
                            <IconButton label={m.fullscreen ? '退出全屏' : '全屏'} onClick={p.onFullscreen}>
                                {m.fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
                            </IconButton>
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
}

function Volume({ media, onVolume, onMute }: { media: MediaState; onVolume: (v: number) => void; onMute: () => void }) {
    const v = media.muted ? 0 : media.volume
    return (
        <div className="group/vol flex items-center">
            <IconButton label={media.muted ? '取消静音' : '静音'} onClick={onMute}>
                {v === 0 ? (
                    <VolumeX className="size-5" />
                ) : v < 0.5 ? (
                    <Volume1 className="size-5" />
                ) : (
                    <Volume2 className="size-5" />
                )}
            </IconButton>
            <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={v}
                aria-label="音量"
                onChange={e => onVolume(Number(e.target.value))}
                onPointerDown={e => e.stopPropagation()}
                className="volume h-1 w-0 cursor-pointer opacity-0 transition-[width,opacity] duration-300 ease-(--ease-out) group-hover/vol:w-24 group-hover/vol:opacity-100 focus-visible:w-24 focus-visible:opacity-100"
                style={{ '--v': `${v * 100}%` } as React.CSSProperties}
            />
        </div>
    )
}
