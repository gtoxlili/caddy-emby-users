import { ArrowLeft } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { describeError } from '../api/error'
import { lightSource, posterUrl } from '../api/images'
import type { Item } from '../api/types'
import { titleOf } from '../components/links'
import { clock, dateTime, episodeLabel, relative, ticksToSeconds } from '../format'
import { lightStyle } from '../light/palette'
import { useLightOf, useRoomLight } from '../light/room'
import { Avatar } from '../ui/avatar'
import { Button } from '../ui/button'
import { Empty } from '../ui/empty'
import { Loading } from '../ui/spinner'
import { toast } from '../ui/toast'
import { ActivityList } from './activity-list'
import {
    useDeleteDevice,
    useDevices,
    useFavoritesOf,
    useSessions,
    useUserActivity,
    useUsers,
    useWatching,
} from './data'
import { UserMenu } from './dialogs'
import { Badge, PageTitle, Panel } from './shell'

/** Something this person is in the middle of, its poster lit in its own colour. */
function WatchRow({ it }: { it: Item }) {
    const pos = ticksToSeconds(it.UserData?.PlaybackPositionTicks)
    const poster = posterUrl(it, 160)
    const light = useLightOf(lightSource(it))
    return (
        <li className="flex items-center gap-3.5" style={lightStyle(light)}>
            {poster ? (
                <img src={poster} alt="" className="lit h-[72px] w-12 shrink-0 rounded-md object-cover" />
            ) : (
                <div className="h-[72px] w-12 shrink-0 rounded-md bg-white/8" />
            )}
            <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{titleOf(it)}</p>
                <p className="mt-0.5 truncate text-[12.5px] text-(--text-2) tabular">
                    {it.Type === 'Episode' ? `${episodeLabel(it)}，` : ''}
                    {pos > 0 ? `看到 ${clock(pos)}` : '接下来看这一集'}
                    {it.UserData?.LastPlayedDate ? `　${relative(it.UserData.LastPlayedDate)}` : ''}
                </p>
            </div>
        </li>
    )
}

export default function UserPage() {
    const { uid = '' } = useParams()
    const navigate = useNavigate()
    const users = useUsers()
    const user = users.data?.find(u => u.Id === uid)
    const watching = useWatching(user?.Id)
    const favorites = useFavoritesOf(user?.Id)
    const devices = useDevices()
    const sessions = useSessions()
    const removeDevice = useDeleteDevice()
    const activity = useUserActivity(user?.Id)
    const mine = (devices.data ?? []).filter(d => d.LastUserId === uid)
    const live = (sessions.data ?? []).filter(s => s.UserId === uid)
    useRoomLight(lightSource(watching.data?.[0]))

    if (users.isPending) return <Loading className="min-h-[50svh]" />
    if (!user)
        return (
            <Empty title="没有这个账号" action={<Button onClick={() => navigate('/manage/users')}>回到账号</Button>} />
        )

    return (
        <>
            <Link
                to="/manage/users"
                className="mb-4 inline-flex items-center gap-1 text-[13px] text-(--text-2) hover:text-(--text)"
            >
                <ArrowLeft className="size-3.5" /> 账号
            </Link>
            <PageTitle
                hint={
                    <span className="tabular">
                        {dateTime(user.DateCreated)} 建的
                        {user.LastLoginDate ? `　上次登录是${relative(user.LastLoginDate)}` : '　还没登录过'}
                    </span>
                }
                aside={<UserMenu user={user} onDeleted={() => navigate('/manage/users')} />}
            >
                <span className="inline-flex flex-wrap items-center gap-3">
                    <Avatar name={user.Name} size={42} />
                    {user.Name}
                    {user.Policy.IsAdministrator && <Badge tone="light">管理员</Badge>}
                    {user.Policy.IsDisabled && <Badge tone="danger">停用</Badge>}
                    {!user.HasPassword && <Badge>没有密码</Badge>}
                </span>
            </PageTitle>

            <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="接着看">
                    {watching.isPending ? (
                        <Loading className="py-4" />
                    ) : watching.data?.length ? (
                        <ul className="grid gap-3.5">
                            {watching.data.map(it => (
                                <WatchRow key={it.Id} it={it} />
                            ))}
                        </ul>
                    ) : (
                        <p className="py-4 text-center text-[13.5px] text-(--text-2)">还没在看什么。</p>
                    )}
                </Panel>
                <div className="flex flex-col gap-4">
                    <Panel title="设备">
                        {devices.isPending ? (
                            <Loading className="py-4" />
                        ) : mine.length ? (
                            <ul className="grid gap-3">
                                {mine.map(d => {
                                    const s = live.find(x => x.DeviceId === d.Id)
                                    return (
                                        <li key={d.Id} className="flex items-center gap-3">
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-[14px]">
                                                    {d.Name} <span className="text-(--text-2)">　{d.AppName}</span>
                                                </p>
                                                <p className="text-[12.5px] text-(--text-2) tabular">
                                                    {relative(d.DateLastActivity)}
                                                    {s?.NowPlayingItem ? `　在看《${titleOf(s.NowPlayingItem)}》` : ''}
                                                </p>
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="danger"
                                                loading={removeDevice.isPending && removeDevice.variables === d.Id}
                                                onClick={() =>
                                                    removeDevice.mutate(d.Id, {
                                                        onSuccess: () => toast('移除了，这台设备要重新登录', 'success'),
                                                        onError: e => toast(describeError(e), 'error'),
                                                    })
                                                }
                                            >
                                                移除
                                            </Button>
                                        </li>
                                    )
                                })}
                            </ul>
                        ) : (
                            <p className="py-4 text-center text-[13.5px] text-(--text-2)">没有登录着的设备。</p>
                        )}
                    </Panel>
                    <Panel title="最近动态">
                        {activity.isPending ? (
                            <Loading className="py-4" />
                        ) : (
                            <ActivityList items={(activity.data ?? []).slice(0, 8)} dense />
                        )}
                    </Panel>
                    <Panel title="收藏" className="flex-1">
                        {favorites.isPending ? (
                            <Loading className="py-4" />
                        ) : favorites.data?.length ? (
                            <ul className="flex flex-wrap gap-2">
                                {favorites.data.map(s => (
                                    <li
                                        key={s.Id}
                                        className="flex items-center gap-2 rounded-lg bg-white/6 py-1.5 pr-3 pl-1.5 text-[13px]"
                                    >
                                        {posterUrl(s, 80) && (
                                            <img
                                                src={posterUrl(s, 80) ?? ''}
                                                alt=""
                                                className="h-8 w-[22px] rounded-sm object-cover"
                                            />
                                        )}
                                        {s.Name}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="py-4 text-center text-[13.5px] text-(--text-2)">没有收藏。</p>
                        )}
                    </Panel>
                </div>
            </div>
        </>
    )
}
