import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../cn'

/** The address in the browser, split the way Emby apps ask for it when connecting by hand. */
export function serverAddress() {
    const { protocol, hostname, port } = window.location
    const https = protocol === 'https:'
    const effectivePort = port || (https ? '443' : '80')
    // Emby's host field assumes http without a scheme; over https the scheme has to be typed.
    const host = https ? `https://${hostname}` : hostname
    return { host, port: effectivePort, url: `${protocol}//${window.location.host}` }
}

export async function copyText(text: string) {
    try {
        await navigator.clipboard.writeText(text)
    } catch {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
    }
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
    const [done, setDone] = useState(false)
    return (
        <button
            type="button"
            onClick={async () => {
                await copyText(text)
                setDone(true)
                setTimeout(() => setDone(false), 1600)
            }}
            className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full bg-white/10 px-2.5 text-[12px] text-(--text) transition-colors hover:bg-white/16',
                className,
            )}
        >
            {done ? <Check className="size-3" /> : <Copy className="size-3" />}
            {done ? '已复制' : '复制地址'}
        </button>
    )
}

/** How to watch on a television or in a phone app: the same account works there. */
export function ClientGuide({ compact }: { compact?: boolean }) {
    const { host, port, url } = serverAddress()
    return (
        <div className={cn('grid gap-3 text-pretty', compact ? 'text-[13px]' : 'text-[14.5px]')}>
            <div className="rounded-2xl bg-white/6 p-3.5 shadow-[inset_0_1px_0_rgb(255_255_255/.08)]">
                <div className="text-[12px] text-(--text-3)">服务器地址</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium break-all text-(--text) tabular">
                        {host}
                        <span className="text-(--text-3)">:{port}</span>
                    </span>
                    <CopyButton text={url} />
                </div>
            </div>
            <ol className="grid list-decimal gap-1.5 pl-5 text-(--text-2) marker:text-(--text-3)">
                <li>电视、盒子上装 Emby；手机和平板可以用 Emby、Infuse 或 SenPlayer。</li>
                <li>
                    添加服务器时选手动，主机填 <em className="text-(--accent) not-italic tabular">{host}</em>，端口填{' '}
                    <em className="text-(--accent) not-italic tabular">{port}</em>。
                </li>
                <li>用这里的账号密码登录。看到哪、收藏了什么，两边是同一份。</li>
            </ol>
        </div>
    )
}
