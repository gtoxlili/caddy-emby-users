# caddy-emby-users

Separate local users for one upstream Emby account. Watch history, resume points,
favorites and preferences stay local. The upstream sees one persistent device.

## Build

Caddy 2.11.7+. Pure Go SQLite; no cgo required.

```sh
xcaddy build v2.11.7 --with github.com/gtoxlili/caddy-emby-users
```

This resolves to the newest release tag; pin one with `@vX.Y.Z`. CI tags a release for
every tested commit on main, on a commit that adds the built web client; main itself
holds only its source. A build from a main commit works but has no web client and leaves
`/web/` to the upstream server.

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
| `user_image` | None. A picture file every local account shows as its own, served without a token at `/Users/{id}/Images/Primary`; clients that use the user's picture as the server icon (Lenna) show it as the site's icon |
| `transport` | [Caddy HTTP](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#the-http-transport); response header timeout 30s |

Identity defaults stay fixed across upgrades. Custom profiles should set all
identity fields consistently.

Persist the database directory. Caddy Docker defaults to `/data/caddy/emby-users.db`.
This SQLite database is independent of Caddy's certificate storage. Validation
leaves it untouched; startup opens it. Reloads preserve local session and playback
state. Passwords use Argon2id, local tokens use SHA-256 hashes, and the upstream
access token is stored in the database.

## Restricted upstreams

Clients see a complete Emby server even when the upstream sits behind a proxy that
accepts only part of the API, as some hosted services do:

- Forwarded paths take the official spelling of Emby's API templates, and so do the
  names of the query parameters each template documents; path parameters and query
  values keep their text. Emby matches both case-insensitively and some clients send
  them lowercased. The templates and their parameters in `routes.txt` come from the
  official SDK's OpenAPI document (`scripts/gen_routes.py`).
- Reads that clients load without error handling answer empty when the upstream refuses
  them: the language list (Emby's ISO 639-2 table in `cultures.json`,
  `scripts/gen_cultures.py`), special features, local trailers, home section items,
  display preferences, upcoming and missing episodes, theme media, critic reviews, intros,
  instant mixes, channels and live TV.
- External text subtitles (SRT, ASS, SSA, WebVTT; UTF-8, UTF-16 or GBK) are converted to
  the `Stream.json`, `.srt` or `.vtt` the client asks for when the upstream redirects to
  the original file instead.
- Sources and streams the upstream leaves unnamed get Emby's titles. PlaybackInfo's
  default audio and subtitle streams follow the streams named in the request, then the
  caller's own language settings once they save any.
- Redirect bodies are dropped; the Location carries the caller's token.

## Web client

Browsers get a web client at `/web/`; `/` redirects there. It replaces Emby's own web
app on this site; Emby's apps and the files they check under `/web/` keep working.

- Sign in with the same local account as the apps. Continue watching, favorites and
  watched marks are the same in both.
- Plays MP4 the browser decodes as is. Other files (MKV, Dolby or DTS sound) are
  remuxed in the browser over MSE, so an upstream that only serves files still plays:
  the picture is copied, sound MSE cannot take is converted to stereo AAC in
  WebAssembly, and embedded SRT, ASS and PGS subtitles are read out of the file.
  iPhone needs iOS 17.1. What the browser cannot decode at all (TrueHD, HEVC without
  hardware support) goes to an upstream HLS transcode where the server offers one;
  without one, a TrueHD-only file plays without sound.
- Text subtitles come from the server as WebVTT; VobSub is burned into a transcode
  where the server offers one.
- Administrators manage accounts and devices at `/web/manage`.

The client is source in `ui/`; CI builds it into release tags. To work on it (Node 26,
pnpm), run Caddy with the plugin and:

```sh
cd ui
pnpm install
EMBY_USERS_DEV_API=http://127.0.0.1:8080 pnpm dev   # the Caddy site
pnpm check
```

`pnpm build` writes `ui/dist`, which git ignores; it is only needed to embed the client in
a binary built from source.

## Accounts

Create the first administrator with the command below; the rest can be done at
`/web/manage`. Run as the same user and environment as Caddy. In Docker, run inside the container:

```sh
caddy emby-users passwd alice --admin
caddy emby-users list
```

Pass `--db /path/to/emby-users.db` for a custom path. The management pages use these
Emby API endpoints, which also work with a local administrator token:

| Request | Body / query |
| --- | --- |
| `POST /Users/New` | `{"Name":"bob","Password":"..."}` |
| `POST /Users/{id}/Password` | `{"NewPw":"..."}` |
| `POST /Users/{id}/Policy` | `{"IsDisabled":true}` |
| `DELETE /Users/{id}` | |
| `GET /Sessions` | |
| `GET /System/ActivityLog/Entries` | `StartIndex`, `Limit`, `MinDate`, `UserId`; sign-ins, playback, account changes, kept 90 days |
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
(cd ui && pnpm check && pnpm build)
go vet ./...
go test -race ./...
```

Without a build in `ui/dist` the web client tests are skipped.

Includes real Caddy validation/reload, TLS transport, Range and cancellation tests.

MIT
