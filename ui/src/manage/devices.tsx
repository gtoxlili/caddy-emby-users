import { useState } from 'react'
import { Link } from 'react-router'
import { describeError } from '../api/error'
import type { Device } from '../api/types'
import { titleOf } from '../components/links'
import { dateTime, relative } from '../format'
import { Button } from '../ui/button'
import { Confirm } from '../ui/dialog'
import { Loading } from '../ui/spinner'
import { toast } from '../ui/toast'
import { useDeleteDevice, useDevices, useSessions } from './data'
import { PageTitle, Panel } from './shell'

export default function Devices() {
    const devices = useDevices()
    const sessions = useSessions()
    const remove = useDeleteDevice()
    const [target, setTarget] = useState<Device | null>(null)
    const live = (id: string) => (sessions.data ?? []).find(s => s.DeviceId === id)

    return (
        <>
            <PageTitle hint="每台登录过的设备一行，一台设备一个会话。移除之后那台设备要重新登录。">设备</PageTitle>
            <Panel className="overflow-x-auto" bodyClassName="p-3 sm:p-5">
                {devices.isPending ? (
                    <Loading />
                ) : (
                    <table className="roster">
                        <thead>
                            <tr>
                                <th>设备</th>
                                <th>应用</th>
                                <th>账号</th>
                                <th>最近活动</th>
                                <th>此刻</th>
                                <th aria-label="操作" />
                            </tr>
                        </thead>
                        <tbody>
                            {(devices.data ?? []).map(d => {
                                const s = live(d.Id)
                                return (
                                    <tr key={d.Id}>
                                        <td className="font-medium">{d.Name}</td>
                                        <td className="text-(--text-2)">
                                            {d.AppName} <span className="text-(--text-3)">{d.AppVersion}</span>
                                        </td>
                                        <td>
                                            <Link to={`/manage/users/${d.LastUserId}`} className="hover:text-white">
                                                {d.LastUserName}
                                            </Link>
                                        </td>
                                        <td className="text-(--text-2)" title={dateTime(d.DateLastActivity)}>
                                            {relative(d.DateLastActivity)}
                                        </td>
                                        <td className="max-w-[260px] truncate text-(--text-2)">
                                            {s?.NowPlayingItem ? (
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="live-dot size-1.5 rounded-full bg-(--accent)" />
                                                    在看《{titleOf(s.NowPlayingItem)}》
                                                </span>
                                            ) : (
                                                <span className="text-(--text-3)">—</span>
                                            )}
                                        </td>
                                        <td className="text-right">
                                            <Button size="sm" variant="danger" onClick={() => setTarget(d)}>
                                                移除
                                            </Button>
                                        </td>
                                    </tr>
                                )
                            })}
                            {devices.data?.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="py-8 text-center text-(--text-2)">
                                        还没有设备登录过。
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                )}
            </Panel>
            <Confirm
                open={!!target}
                onOpenChange={o => !o && setTarget(null)}
                title={`移除 ${target?.Name}？`}
                description={`${target?.LastUserName} 在这台设备上要重新登录。看到哪、收藏了什么都不受影响。`}
                confirmText="移除设备"
                danger
                loading={remove.isPending}
                onConfirm={() => {
                    if (!target) return
                    remove.mutate(target.Id, {
                        onSuccess: () => {
                            toast('移除了', 'success')
                            setTarget(null)
                        },
                        onError: e => toast(describeError(e), 'error'),
                    })
                }}
            />
        </>
    )
}
