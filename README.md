# caddy-emby-users

Separate local users for one upstream Emby account. Watch history, resume points,
favorites and preferences stay local. The upstream sees one persistent device.

## Build

Caddy 2.11.7+. Pure Go SQLite; no cgo required.

```sh
xcaddy build v2.11.7 --with github.com/gtoxlili/caddy-emby-users
```

## Configure

```caddyfile
emby.example.com {
    emby_users {
        upstream https://upstream.example.com
        username {env.EMBY_USERNAME}
        password {env.EMBY_PASSWORD}
    }
}
```

The handler owns Caddy's reverse proxy. API calls and media share its transport;
Host follows the upstream URL, and client forwarding headers are removed.
`upstream` accepts an HTTP(S) origin without a path. String options support `{env.*}`.

**Migration:** replace the old `emby_users` + `reverse_proxy` pair with the block
above. Keep the existing database path.

| Option | Default |
| --- | --- |
| `database` | `emby-users.db` in `caddy.AppDataDir()` |
| `client_name` / `device_name` | `Emby Web` / `Chrome` |
| `device_id` | Generated once, saved in SQLite |
| `client_version` | `4.8.11.0` |
| `user_agent` | Windows / Chrome 131 browser UA |
| `transport` | [Caddy HTTP](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#the-http-transport); response header timeout 30s |

Identity defaults stay fixed across upgrades. Custom profiles should set all
identity fields consistently.

Persist the database directory. Caddy Docker defaults to `/data/caddy/emby-users.db`.
This SQLite database is independent of Caddy's certificate storage. Validation
leaves it untouched; startup opens it. Reloads preserve local session and playback
state. Passwords use Argon2id, local tokens use SHA-256 hashes, and the upstream
access token is stored in the database.

## Accounts

Run as the same user and environment as Caddy. In Docker, run inside the container:

```sh
caddy emby-users passwd alice --admin
caddy emby-users list
```

Pass `--db /path/to/emby-users.db` for a custom path. Further management uses
Emby's API with a local administrator token:

| Request | Body / query |
| --- | --- |
| `POST /Users/New` | `{"Name":"bob","Password":"..."}` |
| `POST /Users/{id}/Password` | `{"NewPw":"..."}` |
| `POST /Users/{id}/Policy` | `{"IsDisabled":true}` |
| `DELETE /Users/{id}` | |
| `GET /Sessions` | |
| `DELETE /Devices?Id=...` | |
| `POST /EmbyUsers/Import?UserId=...` | Import upstream history once |

## Limits

- Local admins manage local accounts. Shared-account changes, remote control, playlist
  writes and sync downloads are blocked.
- Upstream concurrency limits apply. Concurrent transcodes may interfere when
  sharing one device.
- History-derived lists fetch at most 500 items. Unplayed totals are estimated;
  filtered latest lists may contain fewer items than requested.
- Forwarded API bodies: 1 MiB. Rewritten JSON/HLS responses: 16 MiB. Media streams
  without whole-body buffering.

## Test

```sh
go vet ./...
go test -race ./...
```

Includes real Caddy validation/reload, TLS transport, Range and cancellation tests.

MIT
