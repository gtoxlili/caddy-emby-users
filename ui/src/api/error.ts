export class ApiError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
    }
}

/** One sentence for a person. The handler's 4xx texts are English; each status gets its own line here. */
export function describeError(e: unknown): string {
    if (e instanceof ApiError) {
        if (e.status === 401) {
            if (/disabled/i.test(e.message)) return '这个账号已被停用'
            if (/invalid username or password/i.test(e.message)) return '用户名或密码不对'
            return '登录已失效，请重新登录'
        }
        if (e.status === 429) return '试得太频繁了，过一刻钟再来'
        if (e.status === 403) {
            if (/current password/i.test(e.message)) return '当前密码不对'
            return '你没有这个权限'
        }
        if (e.status === 404) return '找不到这个内容'
        if (e.status === 400) {
            if (/already exists/i.test(e.message)) return '这个用户名已经有人用了'
            if (/Name must be/i.test(e.message)) return '用户名要 1 到 64 个字，不能有斜杠，前后不能有空格'
            if (/own account/i.test(e.message)) return '不能删除自己的账号'
            if (/own administrator/i.test(e.message)) return '不能取消自己的管理员身份'
            return e.message
        }
        if (e.status === 502 || e.status === 504) return 'Emby 服务器暂时没有响应，稍后再试'
        if (e.status >= 500) return '服务器出了点问题，稍后再试'
        return e.message
    }
    if (e instanceof TypeError) return '连不上服务器，检查一下网络'
    return e instanceof Error ? e.message : String(e)
}
