import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useUser } from '../auth'
import { titleOf } from '../components/links'
import { relative } from '../format'
import { Avatar } from '../ui/avatar'
import { Button } from '../ui/button'
import { Loading } from '../ui/spinner'
import { useDevices, useSessions, useUsers } from './data'
import { CreateUserDialog, UserMenu } from './dialogs'
import { Badge, PageTitle, Panel } from './shell'

export default function Users() {
    const me = useUser()
    const users = useUsers()
    const devices = useDevices()
    const sessions = useSessions()
    const [create, setCreate] = useState(false)
    const deviceCount = (uid: string) => (devices.data ?? []).filter(d => d.LastUserId === uid).length
    const watching = (uid: string) => (sessions.data ?? []).find(s => s.UserId === uid && s.NowPlayingItem)

    return (
        <>
            <PageTitle
                hint="一人一个账号。看到哪、收藏了什么跟着账号走，网页和 Emby App 里是同一份；Emby 那边只看得到一个共享账号。"
                aside={
                    <Button variant="bright" icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
                        新建账号
                    </Button>
                }
            >
                账号
            </PageTitle>
            <Panel className="overflow-x-auto" bodyClassName="p-3 sm:p-5">
                {users.isPending ? (
                    <Loading />
                ) : (
                    <table className="roster">
                        <thead>
                            <tr>
                                <th>用户名</th>
                                <th>身份</th>
                                <th>上次登录</th>
                                <th>设备</th>
                                <th>此刻</th>
                                <th aria-label="操作" />
                            </tr>
                        </thead>
                        <tbody>
                            {(users.data ?? []).map(u => {
                                const w = watching(u.Id)
                                return (
                                    <tr key={u.Id} className={u.Policy.IsDisabled ? 'opacity-55' : undefined}>
                                        <td>
                                            <Link
                                                to={`/manage/users/${u.Id}`}
                                                className="inline-flex items-center gap-2.5 font-medium hover:text-white"
                                            >
                                                <Avatar name={u.Name} size={26} />
                                                {u.Name}
                                            </Link>
                                            {u.Id === me.Id && (
                                                <span className="ml-2 text-[12px] text-(--text-3)">我</span>
                                            )}
                                        </td>
                                        <td className="space-x-1.5">
                                            {u.Policy.IsAdministrator && <Badge tone="light">管理员</Badge>}
                                            {u.Policy.IsDisabled && <Badge tone="danger">停用</Badge>}
                                            {!u.HasPassword && <Badge>没有密码</Badge>}
                                            {!u.Policy.IsAdministrator && !u.Policy.IsDisabled && u.HasPassword && (
                                                <span className="text-(--text-3)">—</span>
                                            )}
                                        </td>
                                        <td className="text-(--text-2)">
                                            {u.LastLoginDate ? relative(u.LastLoginDate) : '还没有'}
                                        </td>
                                        <td>{deviceCount(u.Id) || <span className="text-(--text-3)">0</span>}</td>
                                        <td className="max-w-[260px] truncate text-(--text-2)">
                                            {w?.NowPlayingItem ? (
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="live-dot size-1.5 rounded-full bg-(--accent)" />
                                                    在看《{titleOf(w.NowPlayingItem)}》
                                                </span>
                                            ) : (
                                                <span className="text-(--text-3)">—</span>
                                            )}
                                        </td>
                                        <td className="text-right">
                                            <UserMenu user={u} />
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                )}
            </Panel>
            <CreateUserDialog open={create} onOpenChange={setCreate} />
        </>
    )
}
