# caddy-emby-users

给 Emby 服务器加一套独立账号的 Caddy 插件。

朋友用插件里的账号登录，所有请求通过同一个上游账号到达真正的 Emby 服务器。每个人的观看记录和续播位置各自独立，收藏与客户端设置也互不影响。手里只有一个 Emby 账号（比如服务商给的普通账号，开不了子账号），又想分给几个朋友一起看，就是它的用途。

客户端照常连接。官方 App 不用改设置，Infuse、SenPlayer 这类第三方客户端也一样。

## 工作方式

插件是一个 HTTP 中间件，放在 `reverse_proxy` 前面。

- 登录请求由插件处理。它校验本地账号，签发自己的 token，上游看不到朋友的账号和密码。
- 其余请求转发前，插件把 token 和路径里的 UserId 换成上游账号的；响应回来，再把上游的 token 和 UserId 换回朋友自己的。播放地址里的 `api_key` 也会换。插件没签发过的 token 直接返回 401，不会转给上游。
- 播放进度上报和标记已看记在插件的 SQLite 里，收藏、评分也是，都不写进上游账号。返回给客户端的每个条目，`UserData` 都换成这个人自己的。
- 继续观看和下一集由插件计算，按已看、收藏或可续播筛选的列表也是。剧集的未看集数按本人的记录算。
- `UserSettings` 和 `DisplayPreferences` 在本地应答，`/Sessions`、`/Devices` 与 WebSocket 心跳也是。
- 会改动共享账号的写请求不转发，比如删除条目和刷新媒体库，也包括改上游用户配置、建播放列表。上游配置、日志、API key、文件系统和插件管理接口也会拦截，本地管理员只管理本地账号。
- 上游看到的始终是同一个客户端、同一台设备。客户端在授权头和查询参数里报的名字与设备 ID 会被换掉，`User-Agent` 也统一成一个值。

## 构建

```sh
xcaddy build --with github.com/gtoxlili/caddy-emby-users
```

需要 Caddy v2.11.7 以上。插件用纯 Go 的 SQLite 驱动，构建不需要 cgo。

## 配置

```caddyfile
emby.example.com {
	emby_users {
		upstream https://upstream.example.com
		username {env.EMBY_USERNAME}
		password {env.EMBY_PASSWORD}
	}
	reverse_proxy https://upstream.example.com {
		header_up Host upstream.example.com
		header_up -X-Forwarded-For
		header_up -X-Forwarded-Host
		header_up -X-Forwarded-Proto
		header_up -Via
	}
}
```

`reverse_proxy` 默认会把客户端的 IP 写进 `X-Forwarded-For`，还会加一个 `Via` 头。上面四行把它们去掉，上游就只看得到 Caddy 所在机器的地址。

| 选项 | 说明 |
|---|---|
| `upstream` | 上游 Emby 服务器的地址，和 `reverse_proxy` 指向同一台。插件自己调用上游 API 时也用它 |
| `username`、`password` | 上游账号。支持 `{env.*}` 占位符 |
| `database` | SQLite 文件路径，默认是 Caddy 数据目录下的 `emby-users.db` |
| `client_name` | 上游看到的客户端名，默认 `Emby Web` |
| `device_name` | 上游看到的设备名，默认 `Chrome` |
| `device_id` | 上游设备 ID。不填时生成随机的 32 位十六进制 ID，保存到数据库，重启和热重载时复用 |
| `client_version` | 上游看到的客户端版本，默认 `4.8.11.0`，独立于插件版本 |
| `user_agent` | 上游看到的完整 User-Agent，默认是 Windows 上的 Chrome 131 浏览器 UA |

`emby_users` 自动排在 `reverse_proxy` 前面，不需要写 `order` 或 `route`。

所有身份选项都支持 `{env.*}` 占位符。默认身份固定，不随插件升级变化。需要自定义时，应把客户端名、设备名、客户端版本和 User-Agent 配成同一套身份。登录、插件内部 API 调用、转发和匿名资源请求都使用它；客户端原有的授权信息和查询参数会被替换，浏览器设备提示头也会移除。

数据库要放在持久化的目录里。插件第一次登录上游后会把 token 连同设备身份存进数据库，重启时仅复用与当前身份匹配的 token。改变身份配置，或升级前保存的 token 没有身份记录时，会在下一次需要认证的请求中重新登录一次。上游已有的旧设备记录不会自动删除。

## 管理账号

第一个管理员用命令行创建。密码从终端读取，标准输入不是终端时读第一行：

```sh
caddy emby-users passwd alice --admin
caddy emby-users list
```

跑在 Docker 里的话，在容器里执行同样的命令，例如 `docker exec -it caddy caddy emby-users passwd alice --admin`。命令可以在服务运行时执行，已登录的会话不受影响。

之后的管理都走 Emby 自带的用户接口。先用管理员账号登录拿到 token：

```sh
curl -s https://emby.example.com/Users/AuthenticateByName \
  -H 'Content-Type: application/json' \
  -H 'X-Emby-Authorization: MediaBrowser Client="curl", Device="curl", DeviceId="admin-cli", Version="1"' \
  -d '{"Username":"alice","Pw":"..."}' | jq -r .AccessToken
```

然后带上 `X-Emby-Token: <token>` 调用：

| 操作 | 请求 |
|---|---|
| 新建账号 | `POST /Users/New`，body `{"Name":"bob","Password":"..."}` |
| 列出账号 | `GET /Users` |
| 重设密码 | `POST /Users/{id}/Password`，body `{"NewPw":"..."}` |
| 清空密码 | `POST /Users/{id}/Password`，body `{"ResetPassword":true}` |
| 停用或设为管理员 | `POST /Users/{id}/Policy`，body `{"IsDisabled":true}` 或 `{"IsAdministrator":true}` |
| 删除账号 | `DELETE /Users/{id}` |
| 查看在线设备与正在播放 | `GET /Sessions` |
| 踢下线某台设备 | `DELETE /Devices?Id={设备 ID}` |
| 导入上游账号原有的记录 | `POST /EmbyUsers/Import?UserId={id}` |

重设密码、停用账号会让这个账号的其他设备全部下线。普通用户改自己的密码要带上 `CurrentPw`。

上游账号原本的续播位置和收藏不会自动归到任何人名下。用 `/EmbyUsers/Import` 把它们导入到账号主人自己的本地账号里，只需要执行一次。

## 细节与限制

- 一台设备同时只保留一个登录。别人在同一台设备上登录，前一个人的会话就失效了，这和 Emby 本身一致。
- 密码用 Argon2id 保存，本地登录 token 只存 SHA-256 哈希。
- 同一个地址每分钟最多尝试登录 10 次。同一个用户名 15 分钟内失败 10 次后暂停登录。
- 续播规则沿用 Emby 的默认值。播放不到 5% 不记进度，超过 90% 或离结尾不到 1 秒算看完，不到 5 分钟的视频开始播放后停下就算看过。
- 按已看、收藏筛选的列表最多处理最近的 500 个条目。筛选"未看"时，插件从上游当前页里去掉看过的条目，总数是估算值。
- 几个朋友同时看，上游看到的是同一台设备开着几路播放。服务商如果限制同时播放数，会按这个账号计算。上游如果对播放做转码，同一台设备上同时进行的两路转码可能互相顶掉。
- 不支持设备之间的远程控制、播放列表和同步下载。

## 开发

```sh
go test ./...
```

测试里有一个假的上游 Emby 服务器，行为照着一台 Emby 兼容服务器写：忽略 `Ids` 参数，条目 ID 区分大小写，没有 `/UserSettings` 接口。

## License

MIT
