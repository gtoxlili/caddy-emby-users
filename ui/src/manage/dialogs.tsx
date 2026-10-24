import {
    Ban,
    Check,
    Copy,
    Dices,
    History,
    KeyRound,
    MoreHorizontal,
    Pencil,
    Shield,
    ShieldOff,
    Trash2,
    Undo2,
} from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { describeError } from '../api/error'
import type { User } from '../api/types'
import { useUser } from '../auth'
import { copyText } from '../components/client-guide'
import { Button } from '../ui/button'
import { Confirm, Modal } from '../ui/dialog'
import { TextField } from '../ui/field'
import type { MenuEntry } from '../ui/menu'
import { DropMenu } from '../ui/menu'
import { toast } from '../ui/toast'
import {
    generatePassword,
    useCreateUser,
    useDeleteUser,
    useImportUpstream,
    useRenameUser,
    useResetPassword,
    useSetPolicy,
} from './data'

/** The message to send a friend: address, name and password in one go. */
export function inviteText(name: string, password: string) {
    const url = `${window.location.protocol}//${window.location.host}`
    return `${url}/web/\n用户名：${name}\n密码：${password}\n\n浏览器打开就能看。电视或手机上装 Emby，服务器填 ${url}，用同一个账号登录。`
}

function CopyBlock({ text }: { text: string }) {
    const [done, setDone] = useState(false)
    return (
        <div className="relative rounded-2xl bg-white/6 p-4 pr-24 text-[13.5px] leading-relaxed whitespace-pre-wrap shadow-[inset_0_1px_0_rgb(255_255_255/.08)]">
            {text}
            <Button
                size="sm"
                variant={done ? 'bright' : 'glass'}
                className="absolute top-3 right-3"
                icon={done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                onClick={async () => {
                    await copyText(text)
                    setDone(true)
                    setTimeout(() => setDone(false), 1800)
                }}
            >
                {done ? '复制了' : '复制'}
            </Button>
        </div>
    )
}

function PasswordWithDice({
    value,
    onChange,
    label = '初始密码',
    error,
}: {
    value: string
    onChange: (v: string) => void
    label?: string
    error?: string | null
}) {
    return (
        <TextField
            label={label}
            value={value}
            onChange={onChange}
            autoComplete="off"
            spellCheck={false}
            className="[&_input]:font-mono"
            error={error}
            trailing={
                <Button
                    size="sm"
                    variant="ghost"
                    round
                    aria-label="随机生成"
                    icon={<Dices className="size-4" />}
                    onClick={() => onChange(generatePassword())}
                />
            }
        />
    )
}

/** A new account, and right after it the message to forward. */
export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
    const [name, setName] = useState('')
    const [password, setPassword] = useState(generatePassword)
    const [error, setError] = useState<string | null>(null)
    const [created, setCreated] = useState<{ name: string; password: string } | null>(null)
    const create = useCreateUser()
    function reset() {
        setName('')
        setPassword(generatePassword())
        setError(null)
        setCreated(null)
    }
    function submit(e: FormEvent) {
        e.preventDefault()
        setError(null)
        if (!name.trim()) return setError('起个用户名')
        if (password.length < 4) return setError('密码至少 4 位')
        create.mutate(
            { name: name.trim(), password },
            {
                onSuccess: () => setCreated({ name: name.trim(), password }),
                onError: err => setError(describeError(err)),
            },
        )
    }
    return (
        <Modal
            open={open}
            onOpenChange={o => {
                onOpenChange(o)
                if (!o) setTimeout(reset, 200)
            }}
            title={created ? '建好了' : '新建账号'}
            description={
                created
                    ? '把下面这段发给对方。密码对方之后可以自己改。'
                    : '密码随机生成，建好之后给你一段可以直接转发的话。'
            }
        >
            {created ? (
                <>
                    <CopyBlock text={inviteText(created.name, created.password)} />
                    <div className="flex justify-end">
                        <Button variant="bright" onClick={() => onOpenChange(false)}>
                            完成
                        </Button>
                    </div>
                </>
            ) : (
                <form onSubmit={submit} className="grid gap-4" noValidate>
                    <TextField
                        label="用户名"
                        value={name}
                        onChange={setName}
                        autoFocus
                        autoComplete="off"
                        placeholder="比如 xiaoming"
                    />
                    <PasswordWithDice value={password} onChange={setPassword} error={error} />
                    <div className="mt-1 flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            取消
                        </Button>
                        <Button type="submit" variant="bright" loading={create.isPending}>
                            新建账号
                        </Button>
                    </div>
                </form>
            )}
        </Modal>
    )
}

function ResetPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
    const [password, setPassword] = useState(generatePassword)
    const [error, setError] = useState<string | null>(null)
    const [done, setDone] = useState<string | null>(null)
    const reset = useResetPassword()
    function close() {
        onClose()
        setTimeout(() => {
            setPassword(generatePassword())
            setError(null)
            setDone(null)
        }, 200)
    }
    return (
        <Modal
            open={!!user}
            onOpenChange={o => !o && close()}
            title={done ? '重设好了' : `重设 ${user?.Name} 的密码`}
            description={done ? '把新密码发给对方。' : '重设之后，对方所有设备都要用新密码重新登录。'}
        >
            {done && user ? (
                <>
                    <CopyBlock text={inviteText(user.Name, done)} />
                    <div className="flex justify-end">
                        <Button variant="bright" onClick={close}>
                            完成
                        </Button>
                    </div>
                </>
            ) : (
                <form
                    className="grid gap-4"
                    noValidate
                    onSubmit={e => {
                        e.preventDefault()
                        if (!user) return
                        if (password.length < 4) return setError('密码至少 4 位')
                        reset.mutate(
                            { uid: user.Id, password },
                            { onSuccess: () => setDone(password), onError: err => setError(describeError(err)) },
                        )
                    }}
                >
                    <PasswordWithDice label="新密码" value={password} onChange={setPassword} error={error} />
                    <div className="mt-1 flex justify-end gap-2">
                        <Button variant="ghost" onClick={close}>
                            取消
                        </Button>
                        <Button type="submit" variant="bright" loading={reset.isPending}>
                            重设密码
                        </Button>
                    </div>
                </form>
            )}
        </Modal>
    )
}

function RenameDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
    const [name, setName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const rename = useRenameUser()
    const value = name || user?.Name || ''
    return (
        <Modal
            open={!!user}
            onOpenChange={o => !o && onClose()}
            title="改用户名"
            description="对方下次登录要用新名字；已经登录的设备不受影响。"
        >
            <form
                className="grid gap-4"
                noValidate
                onSubmit={e => {
                    e.preventDefault()
                    if (!user) return
                    const n = value.trim()
                    if (!n) return setError('名字不能为空')
                    rename.mutate(
                        { uid: user.Id, name: n },
                        {
                            onSuccess: () => {
                                toast(`改名为 ${n} 了`, 'success')
                                onClose()
                                setName('')
                            },
                            onError: err => setError(describeError(err)),
                        },
                    )
                }}
            >
                <TextField label="用户名" value={value} onChange={setName} autoFocus autoComplete="off" error={error} />
                <div className="mt-1 flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        取消
                    </Button>
                    <Button type="submit" variant="bright" loading={rename.isPending}>
                        改名
                    </Button>
                </div>
            </form>
        </Modal>
    )
}

/** What can be done to an account, for the table row and the account's own page. Your own account can only be renamed. */
export function UserMenu({ user, onDeleted }: { user: User; onDeleted?: () => void }) {
    const me = useUser()
    const policy = useSetPolicy()
    const imp = useImportUpstream()
    const del = useDeleteUser()
    const [reset, setReset] = useState<User | null>(null)
    const [rename, setRename] = useState<User | null>(null)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [confirmImport, setConfirmImport] = useState(false)
    const self = user.Id === me.Id
    const flags = (p: { IsAdministrator?: boolean; IsDisabled?: boolean }, done: string) =>
        policy.mutate(
            { uid: user.Id, policy: p },
            { onSuccess: () => toast(done, 'success'), onError: e => toast(describeError(e), 'error') },
        )

    const entries: MenuEntry[] = [
        { label: '改用户名', icon: <Pencil />, onSelect: () => setRename(user) },
        { label: '导入共享账号的观看记录', icon: <History />, onSelect: () => setConfirmImport(true) },
        ...(self
            ? []
            : [
                  { label: '重设密码', icon: <KeyRound />, onSelect: () => setReset(user) },
                  user.Policy.IsAdministrator
                      ? {
                            label: '取消管理员',
                            icon: <ShieldOff />,
                            onSelect: () => flags({ IsAdministrator: false }, `${user.Name} 不再是管理员了`),
                        }
                      : {
                            label: '设为管理员',
                            icon: <Shield />,
                            onSelect: () => flags({ IsAdministrator: true }, `${user.Name} 现在是管理员了`),
                        },
                  user.Policy.IsDisabled
                      ? {
                            label: '恢复账号',
                            icon: <Undo2 />,
                            onSelect: () => flags({ IsDisabled: false }, `${user.Name} 恢复了`),
                        }
                      : {
                            label: '停用账号',
                            icon: <Ban />,
                            onSelect: () => flags({ IsDisabled: true }, `${user.Name} 停用了，所有设备都已退出`),
                        },
                  { label: '删除账号', icon: <Trash2 />, danger: true, onSelect: () => setConfirmDelete(true) },
              ]),
    ]
    return (
        <>
            <DropMenu
                trigger={
                    <Button
                        variant="ghost"
                        size="sm"
                        round
                        aria-label="操作"
                        icon={<MoreHorizontal className="size-4" />}
                    />
                }
                entries={entries}
            />
            <ResetPasswordDialog user={reset} onClose={() => setReset(null)} />
            <RenameDialog user={rename} onClose={() => setRename(null)} />
            <Confirm
                open={confirmImport}
                onOpenChange={setConfirmImport}
                title={`把共享账号的记录给 ${user.Name}？`}
                description="Emby 上那个共享账号自己的续播点和收藏会复制到这个账号里。适合原本就用那个账号的人，做一次就够。"
                confirmText="导入记录"
                loading={imp.isPending}
                onConfirm={() =>
                    imp.mutate(user.Id, {
                        onSuccess: r => {
                            toast(`导入了 ${r.ImportedItems} 条记录`, 'success')
                            setConfirmImport(false)
                        },
                        onError: e => toast(describeError(e), 'error'),
                    })
                }
            />
            <Confirm
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`删除 ${user.Name}？`}
                description="这个人的观看进度、收藏和登录着的设备会一起删掉，没法恢复。"
                confirmText="删除账号"
                danger
                loading={del.isPending}
                onConfirm={() =>
                    del.mutate(user, {
                        onSuccess: () => {
                            toast(`删除了 ${user.Name}`, 'success')
                            setConfirmDelete(false)
                            onDeleted?.()
                        },
                        onError: e => toast(describeError(e), 'error'),
                    })
                }
            />
        </>
    )
}
