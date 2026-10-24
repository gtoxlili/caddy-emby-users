// Server state, all through TanStack Query. Every key carries the user id, so a different
// person signing in on the same browser never sees someone else's play state.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import * as emby from './api/emby'
import type { CollectionType, Item } from './api/types'
import { useUser } from './auth'

const PAGE = 60

export const keys = {
    server: ['server'] as const,
    views: (uid: string) => ['views', uid] as const,
    latest: (uid: string, view: string) => ['latest', uid, view] as const,
    continue: (uid: string) => ['continue', uid] as const,
    nextFor: (uid: string, series: string) => ['next-for', uid, series] as const,
    item: (uid: string, id: string) => ['item', uid, id] as const,
    seasons: (uid: string, series: string) => ['seasons', uid, series] as const,
    episodes: (uid: string, series: string, season: string) => ['episodes', uid, series, season] as const,
    similar: (uid: string, id: string) => ['similar', uid, id] as const,
    children: (uid: string, id: string) => ['children', uid, id] as const,
    library: (uid: string, view: string, sort: string, filter: string) => ['library', uid, view, sort, filter] as const,
    search: (uid: string, term: string) => ['search', uid, term] as const,
    works: (uid: string, person: string) => ['works', uid, person] as const,
    favorites: (uid: string) => ['favorites', uid] as const,
    sessions: (uid: string) => ['sessions', uid] as const,
}

export function useServer() {
    return useQuery({ queryKey: keys.server, queryFn: emby.systemInfoPublic, staleTime: Number.POSITIVE_INFINITY })
}

export function useServerName(): string {
    const { data } = useServer()
    return data?.ServerName || 'Emby'
}

/** Libraries the web client knows how to show. Music, books, photos and live TV stay in Emby's apps. */
const SHOWN: (CollectionType | undefined)[] = [
    'movies',
    'tvshows',
    'homevideos',
    'musicvideos',
    'boxsets',
    'mixed',
    undefined,
]

export function useViews() {
    const user = useUser()
    return useQuery({
        queryKey: keys.views(user.Id),
        queryFn: async () => (await emby.views(user.Id)).Items.filter(v => SHOWN.includes(v.CollectionType)),
        staleTime: 30 * 60_000,
    })
}

/** What a library's grid lists. */
export function libraryTypes(view: Item | undefined): string {
    switch (view?.CollectionType) {
        case 'movies':
            return 'Movie'
        case 'tvshows':
            return 'Series'
        case 'boxsets':
            return 'BoxSet'
        case 'musicvideos':
            return 'MusicVideo'
        case 'homevideos':
            return 'Video,Movie'
        default:
            return 'Movie,Series,Video'
    }
}

export function useLatest(viewId: string, limit = 20) {
    const user = useUser()
    return useQuery({ queryKey: keys.latest(user.Id, viewId), queryFn: () => emby.latest(user.Id, viewId, limit) })
}

/** Where this person would pick up, newest first: one entry per series, plus unfinished films. */
export function useContinue() {
    const user = useUser()
    return useQuery({
        queryKey: keys.continue(user.Id),
        queryFn: async () => (await emby.resume(user.Id, { Limit: 24, IncludeNextUp: true })).Items,
        staleTime: 0,
    })
}

/** The episode a series would continue from: unfinished, or the next one after the last finished. */
export function useNextFor(seriesId: string | undefined) {
    const user = useUser()
    return useQuery({
        queryKey: keys.nextFor(user.Id, seriesId ?? ''),
        queryFn: async () => (await emby.resume(user.Id, { ParentId: seriesId, Limit: 1 })).Items[0] ?? null,
        enabled: !!seriesId,
        staleTime: 0,
    })
}

export function useItem(id: string | undefined, opts: { fresh?: boolean } = {}) {
    const user = useUser()
    return useQuery({
        queryKey: keys.item(user.Id, id ?? ''),
        queryFn: () => emby.item(user.Id, id ?? ''),
        enabled: !!id,
        staleTime: opts.fresh ? 0 : 60_000,
        refetchOnMount: opts.fresh ? 'always' : true,
    })
}

export function useSeasons(seriesId: string | undefined) {
    const user = useUser()
    return useQuery({
        queryKey: keys.seasons(user.Id, seriesId ?? ''),
        queryFn: async () => (await emby.seasons(user.Id, seriesId ?? '')).Items,
        enabled: !!seriesId,
        staleTime: 0,
    })
}

export function useEpisodes(seriesId: string | undefined, seasonId?: string) {
    const user = useUser()
    return useQuery({
        queryKey: keys.episodes(user.Id, seriesId ?? '', seasonId ?? ''),
        // Episodes Emby only knows from metadata (missing files) cannot be played.
        queryFn: async () =>
            (await emby.episodes(user.Id, seriesId ?? '', seasonId)).Items.filter(e => e.LocationType !== 'Virtual'),
        enabled: !!seriesId,
        staleTime: 0,
    })
}

export function useSimilar(id: string | undefined, limit = 16) {
    const user = useUser()
    return useQuery({
        queryKey: keys.similar(user.Id, id ?? ''),
        queryFn: async () => (await emby.similar(user.Id, id ?? '', limit)).Items,
        enabled: !!id,
        staleTime: 10 * 60_000,
    })
}

/** A collection's or folder's contents. */
export function useChildren(id: string | undefined) {
    const user = useUser()
    return useQuery({
        queryKey: keys.children(user.Id, id ?? ''),
        queryFn: async () =>
            (await emby.items(user.Id, { ParentId: id, SortBy: 'ProductionYear,SortName', SortOrder: 'Ascending' }))
                .Items,
        enabled: !!id,
    })
}

export type LibrarySort = 'added' | 'name' | 'year' | 'rating'
export type LibraryFilter = 'all' | 'unplayed' | 'favorite'

const SORTS: Record<LibrarySort, { SortBy: string; SortOrder: 'Ascending' | 'Descending' }> = {
    added: { SortBy: 'DateCreated,SortName', SortOrder: 'Descending' },
    name: { SortBy: 'SortName', SortOrder: 'Ascending' },
    year: { SortBy: 'ProductionYear,PremiereDate,SortName', SortOrder: 'Descending' },
    rating: { SortBy: 'CommunityRating,SortName', SortOrder: 'Descending' },
}

export function useLibrary(view: Item | undefined, sort: LibrarySort, filter: LibraryFilter) {
    const user = useUser()
    return useInfiniteQuery({
        queryKey: keys.library(user.Id, view?.Id ?? '', sort, filter),
        queryFn: ({ pageParam }) =>
            emby.items(user.Id, {
                ParentId: view?.Id,
                IncludeItemTypes: libraryTypes(view),
                Recursive: true,
                StartIndex: pageParam,
                Limit: PAGE,
                Filters: filter === 'unplayed' ? 'IsUnplayed' : filter === 'favorite' ? 'IsFavorite' : undefined,
                ...SORTS[sort],
            }),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => {
            const loaded = pages.reduce((n, p) => n + p.Items.length, 0)
            return loaded < last.TotalRecordCount && last.Items.length > 0 ? loaded : undefined
        },
        enabled: !!view,
        staleTime: 5 * 60_000,
    })
}

export interface SearchResults {
    titles: Item[]
    episodes: Item[]
    people: Item[]
}

export function useSearch(term: string) {
    const user = useUser()
    const t = term.trim()
    return useQuery({
        queryKey: keys.search(user.Id, t),
        queryFn: async (): Promise<SearchResults> => {
            const [titles, episodes, people] = await Promise.all([
                emby.items(user.Id, {
                    SearchTerm: t,
                    IncludeItemTypes: 'Movie,Series,BoxSet,Video,MusicVideo',
                    Recursive: true,
                    Limit: 48,
                }),
                emby.items(user.Id, { SearchTerm: t, IncludeItemTypes: 'Episode', Recursive: true, Limit: 24 }),
                emby.persons(user.Id, t, 18).catch(() => ({ Items: [] as Item[], TotalRecordCount: 0 })),
            ])
            return { titles: titles.Items, episodes: episodes.Items, people: people.Items }
        },
        enabled: t.length > 0,
    })
}

/** A person's work in this library. */
export function useWorks(personId: string | undefined) {
    const user = useUser()
    return useQuery({
        queryKey: keys.works(user.Id, personId ?? ''),
        queryFn: async () =>
            (
                await emby.items(user.Id, {
                    PersonIds: personId,
                    Recursive: true,
                    IncludeItemTypes: 'Movie,Series',
                    SortBy: 'ProductionYear,SortName',
                    SortOrder: 'Descending',
                })
            ).Items,
        enabled: !!personId,
    })
}

export function useFavorites() {
    const user = useUser()
    return useQuery({
        queryKey: keys.favorites(user.Id),
        queryFn: async () =>
            (
                await emby.items(user.Id, {
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Movie,Series,BoxSet,Video,MusicVideo',
                    Recursive: true,
                })
            ).Items,
        staleTime: 0,
    })
}

export function useOwnSessions() {
    const user = useUser()
    return useQuery({ queryKey: keys.sessions(user.Id), queryFn: emby.sessions, staleTime: 0 })
}

/** After a favourite or watched change every query with UserData in it is stale. Coarse, always right. */
export function useInvalidateUserData() {
    const qc = useQueryClient()
    const user = useUser()
    return () => qc.invalidateQueries({ predicate: q => (q.queryKey as unknown[]).includes(user.Id) })
}

export function useFavoriteMutation() {
    const user = useUser()
    const invalidate = useInvalidateUserData()
    return useMutation({
        mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => emby.setFavorite(user.Id, id, favorite),
        onSettled: () => invalidate(),
    })
}

export function usePlayedMutation() {
    const user = useUser()
    const invalidate = useInvalidateUserData()
    return useMutation({
        mutationFn: ({ id, played }: { id: string; played: boolean }) => emby.markPlayed(user.Id, id, played),
        onSettled: () => invalidate(),
    })
}

export function useHideFromResume() {
    const user = useUser()
    const invalidate = useInvalidateUserData()
    return useMutation({ mutationFn: (id: string) => emby.hideFromResume(user.Id, id), onSettled: () => invalidate() })
}

/** The tab's title: this page's subject, then the server's name. */
export function useTitle(subject?: string | null) {
    const server = useServerName()
    useEffect(() => {
        document.title = subject ? `${subject} - ${server}` : server
    }, [subject, server])
}
