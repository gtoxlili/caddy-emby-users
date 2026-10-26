// The slice of Emby's DTOs the web client reads. Field names and shapes are Emby's own;
// the handler passes upstream documents through with each user's UserData laid over them.

export interface QueryResult<T> {
    Items: T[]
    TotalRecordCount: number
}

export interface UserData {
    PlaybackPositionTicks: number
    PlayCount: number
    IsFavorite: boolean
    Played: boolean
    PlayedPercentage?: number
    UnplayedItemCount?: number
    LastPlayedDate?: string
    Likes?: boolean
}

export type ItemType =
    | 'Movie'
    | 'Series'
    | 'Season'
    | 'Episode'
    | 'BoxSet'
    | 'Video'
    | 'MusicVideo'
    | 'Folder'
    | 'CollectionFolder'
    | 'UserView'
    | 'Person'
    | 'Trailer'
    | (string & {})

export type CollectionType =
    | 'movies'
    | 'tvshows'
    | 'homevideos'
    | 'musicvideos'
    | 'boxsets'
    | 'mixed'
    | 'music'
    | 'books'
    | 'photos'
    | 'livetv'
    | 'playlists'
    | (string & {})

export interface NameId {
    Name: string
    Id: string
}

export interface Person {
    Name: string
    Id: string
    Role?: string
    Type: 'Actor' | 'Director' | 'Writer' | 'Producer' | 'GuestStar' | (string & {})
    PrimaryImageTag?: string
}

export type MarkerType = 'Chapter' | 'IntroStart' | 'IntroEnd' | 'CreditsStart' | (string & {})

export interface Chapter {
    StartPositionTicks: number
    Name?: string
    ImageTag?: string
    MarkerType?: MarkerType
    ChapterIndex?: number
}

export interface MediaStream {
    Type: 'Video' | 'Audio' | 'Subtitle' | 'EmbeddedImage' | (string & {})
    Index: number
    Codec?: string
    Language?: string
    DisplayTitle?: string
    DisplayLanguage?: string
    Title?: string
    IsDefault?: boolean
    IsForced?: boolean
    IsExternal?: boolean
    IsTextSubtitleStream?: boolean
    SupportsExternalStream?: boolean
    Width?: number
    Height?: number
    BitRate?: number
    BitDepth?: number
    Level?: number
    Channels?: number
    ChannelLayout?: string
    Profile?: string
    VideoRange?: string
    ExtendedVideoType?: string
    ExtendedVideoSubTypeDescription?: string
}

export interface MediaSource {
    Id: string
    Name?: string
    Protocol?: 'File' | 'Http' | (string & {})
    Container?: string
    Size?: number
    Bitrate?: number
    RunTimeTicks?: number
    SupportsDirectPlay?: boolean
    SupportsDirectStream?: boolean
    SupportsTranscoding?: boolean
    TranscodingUrl?: string
    TranscodingSubProtocol?: string
    TranscodingContainer?: string
    DirectStreamUrl?: string
    DefaultAudioStreamIndex?: number
    DefaultSubtitleStreamIndex?: number
    MediaStreams: MediaStream[]
    Chapters?: Chapter[]
}

export interface Item {
    Id: string
    Name: string
    OriginalTitle?: string
    Type: ItemType
    MediaType?: 'Video' | 'Audio' | (string & {})
    CollectionType?: CollectionType
    ServerId: string
    IsFolder: boolean
    ParentId?: string
    Overview?: string
    Taglines?: string[]
    Genres?: string[]
    Studios?: NameId[]
    People?: Person[]
    PremiereDate?: string
    EndDate?: string
    ProductionYear?: number
    DateCreated?: string
    OfficialRating?: string
    CommunityRating?: number
    CriticRating?: number
    Status?: 'Continuing' | 'Ended' | (string & {})
    ChildCount?: number
    RecursiveItemCount?: number
    IndexNumber?: number
    IndexNumberEnd?: number
    ParentIndexNumber?: number
    SeriesId?: string
    SeriesName?: string
    SeasonId?: string
    SeasonName?: string
    RunTimeTicks?: number
    Width?: number
    Height?: number
    ImageTags?: Record<string, string>
    BackdropImageTags?: string[]
    ParentBackdropItemId?: string
    ParentBackdropImageTags?: string[]
    ParentLogoItemId?: string
    ParentLogoImageTag?: string
    ParentThumbItemId?: string
    ParentThumbImageTag?: string
    SeriesPrimaryImageTag?: string
    SeriesThumbImageTag?: string
    PrimaryImageAspectRatio?: number
    UserData?: UserData
    MediaSources?: MediaSource[]
    MediaStreams?: MediaStream[]
    Chapters?: Chapter[]
    LocationType?: string
}

export interface PlaybackInfo {
    MediaSources: MediaSource[]
    PlaySessionId: string
    ErrorCode?: 'NotAllowed' | 'NoCompatibleStream' | 'RateLimitExceeded' | (string & {})
}

export interface UserPolicy {
    IsAdministrator: boolean
    IsDisabled: boolean
}

export interface UserConfiguration {
    EnableNextEpisodeAutoPlay: boolean
    SubtitleMode?: string
    SubtitleLanguagePreference?: string
    AudioLanguagePreference?: string
    PlayDefaultAudioTrack?: boolean
}

export interface User {
    Id: string
    Name: string
    ServerId: string
    HasPassword: boolean
    DateCreated: string
    LastLoginDate?: string
    LastActivityDate: string
    Policy: UserPolicy
    Configuration: UserConfiguration
}

export interface AuthenticationResult {
    User: User
    AccessToken: string
    ServerId: string
}

export interface PlayState {
    PositionTicks?: number
    IsPaused: boolean
    CanSeek: boolean
    /** Only when the client said so. */
    PlayMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode'
}

export interface SessionInfo {
    Id: string
    UserId: string
    UserName: string
    Client: string
    DeviceName: string
    DeviceId: string
    ApplicationVersion: string
    LastActivityDate: string
    RemoteEndPoint?: string
    PlayState: PlayState
    NowPlayingItem?: Item
}

export interface Device {
    Id: string
    Name: string
    AppName: string
    AppVersion: string
    LastUserName: string
    LastUserId: string
    DateLastActivity: string
}

export interface PublicSystemInfo {
    ServerName: string
    Version: string
    Id: string
}

export interface ItemCounts {
    MovieCount: number
    SeriesCount: number
    EpisodeCount: number
}

/** Emby 4.10's own activity types, plus user.renamed which Emby has no name for. */
export type ActivityType =
    | 'playback.start'
    | 'user.authenticated'
    | 'user.authenticationfailed'
    | 'user.created'
    | 'user.deleted'
    | 'user.passwordchanged'
    | 'user.policyupdated'
    | 'user.renamed'
    | (string & {})

export interface ActivityEntry {
    Id: number
    Name: string
    Overview?: string
    ShortOverview?: string
    Type: ActivityType
    ItemId?: string
    Date: string
    UserId?: string
    Severity: 'Info' | 'Warn' | 'Error'
    /** The handler's additions to Emby's entry: the names behind it. */
    UserName?: string
    ItemName?: string
    Detail?: string
    DeviceName?: string
    ByUserName?: string
}
