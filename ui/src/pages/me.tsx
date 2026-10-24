import { useMutation } from '@tanstack/react-query'
import { LogOut, SlidersHorizontal } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { deviceId } from '../api/client'
import * as emby from '../api/emby'
import { describeError } from '../api/error'
import { lightSource } from '../api/images'
import { useAuth, useUser } from '../auth'
import { cn } from '../cn'
import { PosterGrid } from '../components/cards'
import { ClientGuide } from '../components/client-guide'
import { PageBody } from '../components/shell'
import { useFavorites, useOwnSessions, useTitle } from '../data'
import { relative } from '../format'
import { useRoomLight } from '../light/room'
import { Avatar } from '../ui/avatar'
import { Button } from '../ui/button'
import { Modal } from '../ui/dialog'
import { PasswordField } from '../ui/password-input'
import { Loading } from '../ui/spinner'
import { Toggle } from '../ui/switch'
import { toast } from '../ui/toast'

function Panel({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section className={cn('glass rounded-panel p-5', className)}>
            <h2 className="mb-3 text-[15px] font-semibold text-(--text)">{title}</h2>
            {children}
        </section>
    )
}

function ChangePassword({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
    const user = useUser()
    const [current, setCurrent] = useState('')
    const [next, setNext] = useState('')
    const [again, setAgain] = useState('')
    const [error, setError] = useState<string | null>(null)
    const m = useMutation({
        mutationFn: () => emby.changePassword(user.Id, current, next),
        onSuccess: () => {
            toast('密码改好了', 'success')
            onOpenChange(false)
            setCurrent('')
            setNext('')
            setAgain('')
        },
        onError: e => setError(describeError(e)),
    })
    function submit(e: FormEvent) {
        e.preventDefault()
        setError(null)
        if (next.length < 4) return setError('新密码至少 4 位')
        if (next !== again) return setError('两次输入的新密码不一样')
        m.mutate()
    }
    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title="修改密码"
            description="改好之后，别的设备会退出登录，要用新密码重新登录。"
        >
            <form onSubmit={submit} className="grid gap-4" noValidate>
                {user.HasPassword && (
                    <PasswordField
                        label="当前密码"
                        value={current}
                        onChange={setCurrent}
                        autoComplete="current-password"
                        autoFocus
                    />
                )}
                <PasswordField label="新密码" value={next} onChange={setNext} autoComplete="new-password" />
                <PasswordField
                    label="再输一次"
                    value={again}
                    onChange={setAgain}
                    autoComplete="new-password"
                    error={error}
                />
                <div className="mt-1 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        取消
                    </Button>
                    <Button type="submit" variant="bright" loading={m.isPending}>
                        修改密码
                    </Button>
                </div>
            </form>
        </Modal>
    )
}

export default function Me() {
    const user = useUser()
    const navigate = useNavigate()
    const { logout, refresh } = useAuth()
    const favorites = useFavorites()
    const sessions = useOwnSessions()
    const [pw, setPw] = useState(false)
    const autoplay = user.Configuration.EnableNextEpisodeAutoPlay
    const setAutoplay = useMutation({
        mutationFn: (v: boolean) => emby.setConfiguration(user.Id, { EnableNextEpisodeAutoPlay: v }),
        onSuccess: () => refresh(),
        onError: e => toast(describeError(e), 'error'),
    })
    const [remembered, setRemembered] = useState(
        () => !!(localStorage.getItem('emby-users.sub-lang') || localStorage.getItem('emby-users.audio-lang')),
    )
    const me = deviceId()
    useRoomLight(lightSource(favorites.data?.[0]))
    useTitle(user.Name)

    return (
        <PageBody>
            <header className="flex flex-wrap items-center gap-4">
                <Avatar name={user.Name} size={60} className="shadow-[0_8px_24px_-8px_rgb(0_0_0/.8)]" />
                <div className="min-w-0 flex-1">
                    <h1 className="truncate font-display text-[32px] leading-none">{user.Name}</h1>
                    <p className="mt-2 text-[13px] text-(--text-2)">
                        {user.Policy.IsAdministrator ? '管理员　' : ''}
                        {user.LastLoginDate ? `上次登录是${relative(user.LastLoginDate)}` : ''}
                    </p>
                </div>
                <div className="flex shrink-0 gap-2 max-sm:basis-full">
                    {user.Policy.IsAdministrator && (
                        <Button
                            icon={<SlidersHorizontal className="size-4" />}
                            onClick={() => navigate('/manage', { viewTransition: true })}
                        >
                            管理
                        </Button>
                    )}
                    <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={() => logout()}>
                        退出登录
                    </Button>
                </div>
            </header>

            <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
                <section className="flex flex-col">
                    <h2 className="mb-4 font-display text-[24px] md:text-[27px]">收藏</h2>
                    {favorites.isPending ? (
                        <Loading className="flex-1" />
                    ) : favorites.data && favorites.data.length > 0 ? (
                        <PosterGrid items={favorites.data} keyPrefix="fav" />
                    ) : (
                        <p className="grid flex-1 place-items-center rounded-panel border border-dashed border-(--line) p-6 text-center text-[14px] text-(--text-2) text-pretty">
                            还没有收藏。在片子的页面点收藏，它会出现在这里，也会出现在 Emby App 的收藏里。
                        </p>
                    )}
                </section>
                <div className="flex flex-col gap-4">
                    <Panel title="播放">
                        <Toggle
                            checked={autoplay}
                            disabled={setAutoplay.isPending}
                            onCheckedChange={v => setAutoplay.mutate(v)}
                            label="自动播放下一集"
                            hint="和 Emby App 里是同一个开关。"
                        />
                        <div className="mt-3 flex items-center justify-between gap-4 border-t border-(--line) pt-3">
                            <div className="grid gap-0.5">
                                <span className="text-[15px] text-(--text)">音轨和字幕</span>
                                <span className="text-[13px] text-(--text-2)">
                                    {remembered ? '这台设备记着上次选的语言。' : '用片子自己的默认音轨和字幕。'}
                                </span>
                            </div>
                            {remembered && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                        localStorage.removeItem('emby-users.sub-lang')
                                        localStorage.removeItem('emby-users.audio-lang')
                                        setRemembered(false)
                                    }}
                                >
                                    忘掉
                                </Button>
                            )}
                        </div>
                    </Panel>
                    <Panel title="账号">
                        <Button onClick={() => setPw(true)} className="w-full justify-between">
                            修改密码
                            <span className="text-(--text-3)">›</span>
                        </Button>
                    </Panel>
                    <Panel title="登录着的设备">
                        {sessions.isPending ? (
                            <Loading className="py-4" />
                        ) : (
                            <ul className="grid gap-2.5 text-[14px]">
                                {(sessions.data ?? []).map(s => (
                                    <li key={s.Id} className="flex items-baseline justify-between gap-3">
                                        <span className="min-w-0 truncate text-(--text)">
                                            {s.DeviceName}
                                            <span className="text-(--text-3)">　{s.Client}</span>
                                        </span>
                                        <span className="shrink-0 text-[12px] text-(--text-3)">
                                            {s.DeviceId === me ? '这台设备' : relative(s.LastActivityDate)}
                                        </span>
                                    </li>
                                ))}
                                {sessions.data?.length === 0 && (
                                    <li className="text-(--text-2)">最近一小时没有别的设备在用。</li>
                                )}
                            </ul>
                        )}
                    </Panel>
                    <Panel title="在电视或手机上看">
                        <ClientGuide compact />
                    </Panel>
                </div>
            </div>
            <ChangePassword open={pw} onOpenChange={setPw} />
        </PageBody>
    )
}
