// Every endpoint the web client uses. All of them are Emby's own; the handler answers the
// ones that touch accounts and play state and passes the rest to the upstream server.

import { deviceId, qs, request } from './client'
import type {
    ActivityEntry,
    AuthenticationResult,
    Device,
    Item,
    ItemCounts,
    PlaybackInfo,
    PublicSystemInfo,
    QueryResult,
    SessionInfo,
    User,
    UserData,
} from './types'

export const TICKS_PER_SECOND = 10_000_000

/** What lists ask for beyond Emby's minimal default fields. */
const LIST_FIELDS =
    'PrimaryImageAspectRatio,ProductionYear,PremiereDate,EndDate,Genres,Overview,OfficialRating,CommunityRating,RunTimeTicks,Status,ChildCount,RecursiveItemCount,DateCreated'
const LIST_IMAGES = { EnableImageTypes: 'Primary,Backdrop,Logo,Thumb', ImageTypeLimit: 1 }

// ---- server and accounts ----

export const systemInfoPublic = () => request<PublicSystemInfo>('/System/Info/Public', { anonymous: true })

export const login = (Username: string, Pw: string) =>
    request<AuthenticationResult>('/Users/AuthenticateByName', {
        method: 'POST',
        body: { Username, Pw },
        anonymous: true,
    })

export const logout = () => request<void>('/Sessions/Logout', { method: 'POST' })
export const me = (uid: string) => request<User>(`/Users/${uid}`)
export const users = () => request<User[]>('/Users')

export const createUser = (Name: string, Password: string) =>
    request<User>('/Users/New', { method: 'POST', body: { Name, Password } })
export const renameUser = (uid: string, Name: string) =>
    request<void>(`/Users/${uid}`, { method: 'POST', body: { Name } })
export const deleteUser = (uid: string) => request<void>(`/Users/${uid}`, { method: 'DELETE' })
export const setPolicy = (uid: string, policy: { IsAdministrator?: boolean; IsDisabled?: boolean }) =>
    request<void>(`/Users/${uid}/Policy`, { method: 'POST', body: policy })
export const changePassword = (uid: string, CurrentPw: string, NewPw: string) =>
    request<void>(`/Users/${uid}/Password`, { method: 'POST', body: { CurrentPw, NewPw } })
export const resetPassword = (uid: string, NewPw: string) =>
    request<void>(`/Users/${uid}/Password`, { method: 'POST', body: { NewPw } })
export const setConfiguration = (uid: string, patch: Record<string, unknown>) =>
    request<void>(`/Users/${uid}/Configuration`, { method: 'POST', body: patch })
/** Copies the shared upstream account's resume points and favorites to one local user. */
export const importUpstream = (uid: string) =>
    request<{ UserId: string; ImportedItems: number }>('/EmbyUsers/Import', { method: 'POST', query: { UserId: uid } })

// ---- browsing ----

export const views = (uid: string) => request<QueryResult<Item>>(`/Users/${uid}/Views`)

export const item = (uid: string, id: string) => request<Item>(`/Users/${uid}/Items/${id}`)

export type ItemsQuery = {
    ParentId?: string
    IncludeItemTypes?: string
    Recursive?: boolean
    StartIndex?: number
    Limit?: number
    Filters?: string
    SearchTerm?: string
    SortBy?: string
    SortOrder?: 'Ascending' | 'Descending'
    PersonIds?: string
    GenreIds?: string
    Fields?: string
}

export const items = (uid: string, query: ItemsQuery) =>
    request<QueryResult<Item>>(`/Users/${uid}/Items`, {
        query: { Fields: LIST_FIELDS, ...LIST_IMAGES, ...query },
    })

export const latest = (uid: string, ParentId: string, Limit = 20) =>
    request<Item[]>(`/Users/${uid}/Items/Latest`, { query: { ParentId, Limit, Fields: LIST_FIELDS, ...LIST_IMAGES } })

/**
 * Where this person would pick up, newest first: unfinished items and, for each series they
 * finished an episode of, the next one. IncludeNextUp merges the two in the handler's own
 * history order, which two separate lists cannot reproduce.
 */
export const resume = (uid: string, query: { ParentId?: string; Limit?: number; IncludeNextUp?: boolean } = {}) =>
    request<QueryResult<Item>>(`/Users/${uid}/Items/Resume`, {
        query: { MediaTypes: 'Video', Fields: LIST_FIELDS, ...LIST_IMAGES, ...query },
    })

export const seasons = (uid: string, seriesId: string) =>
    request<QueryResult<Item>>(`/Shows/${seriesId}/Seasons`, { query: { UserId: uid, Fields: LIST_FIELDS } })

export const episodes = (uid: string, seriesId: string, seasonId?: string) =>
    request<QueryResult<Item>>(`/Shows/${seriesId}/Episodes`, {
        query: { UserId: uid, SeasonId: seasonId, Fields: `${LIST_FIELDS},Chapters`, ...LIST_IMAGES },
    })

export const similar = (uid: string, id: string, Limit = 16) =>
    request<QueryResult<Item>>(`/Items/${id}/Similar`, {
        query: { UserId: uid, Limit, Fields: LIST_FIELDS, ...LIST_IMAGES },
    })

export const persons = (uid: string, SearchTerm: string, Limit = 24) =>
    request<QueryResult<Item>>('/Persons', { query: { UserId: uid, SearchTerm, Limit } })

export const counts = (uid: string) => request<ItemCounts>('/Items/Counts', { query: { UserId: uid } })

// ---- play state ----

export const markPlayed = (uid: string, id: string, played: boolean) =>
    request<UserData>(`/Users/${uid}/PlayedItems/${id}`, { method: played ? 'POST' : 'DELETE' })
export const setFavorite = (uid: string, id: string, favorite: boolean) =>
    request<UserData>(`/Users/${uid}/FavoriteItems/${id}`, { method: favorite ? 'POST' : 'DELETE' })
export const hideFromResume = (uid: string, id: string) =>
    request<UserData>(`/Users/${uid}/Items/${id}/HideFromResume`, { method: 'POST', query: { Hide: true } })

// ---- playback ----

export interface PlaybackRequest {
    startTicks?: number
    mediaSourceId?: string
    audioIndex?: number
    /** -1 asks for no subtitles at all. */
    subtitleIndex?: number
    maxBitrate?: number
}

export const playbackInfo = (uid: string, id: string, profile: unknown, r: PlaybackRequest) =>
    request<PlaybackInfo>(`/Items/${id}/PlaybackInfo`, {
        method: 'POST',
        query: {
            UserId: uid,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            StartTimeTicks: r.startTicks || undefined,
            MediaSourceId: r.mediaSourceId,
            AudioStreamIndex: r.audioIndex,
            SubtitleStreamIndex: r.subtitleIndex,
            MaxStreamingBitrate: r.maxBitrate || undefined,
        },
        body: { DeviceProfile: profile },
    })

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode'

export interface PlayReport {
    ItemId: string
    MediaSourceId: string
    PlaySessionId: string
    PositionTicks: number
    IsPaused: boolean
    PlayMethod: PlayMethod
    AudioStreamIndex?: number
    SubtitleStreamIndex?: number
}

export const reportPlaying = (r: PlayReport) =>
    request<void>('/Sessions/Playing', { method: 'POST', body: { ...r, CanSeek: true } })
export const reportProgress = (r: PlayReport) =>
    request<void>('/Sessions/Playing/Progress', { method: 'POST', body: { ...r, CanSeek: true } })
export const reportStopped = (r: PlayReport, keepalive = false) =>
    request<void>('/Sessions/Playing/Stopped', { method: 'POST', body: r, keepalive })
/** Keeps an upstream transcode alive; the handler forwards it. */
export const ping = (PlaySessionId: string) =>
    request<void>('/Sessions/Playing/Ping', { method: 'POST', query: { PlaySessionId } })
/** Ends an upstream transcode now rather than when it times out. */
export const stopEncoding = (PlaySessionId: string, keepalive = false) =>
    request<void>(`/Videos/ActiveEncodings${qs({ DeviceId: deviceId(), PlaySessionId })}`, {
        method: 'DELETE',
        keepalive,
    })

// ---- activity ----

export const activity = (query: { StartIndex?: number; Limit?: number; MinDate?: string; UserId?: string } = {}) =>
    request<QueryResult<ActivityEntry>>('/System/ActivityLog/Entries', { query })

// ---- sessions and devices ----

export const sessions = () => request<SessionInfo[]>('/Sessions')
export const devices = () => request<QueryResult<Device>>('/Devices')
export const deleteDevice = (Id: string) => request<void>('/Devices', { method: 'DELETE', query: { Id } })
