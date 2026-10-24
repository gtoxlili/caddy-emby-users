// Server state for the management pages. Sessions refresh every ten seconds: who is watching
// what should keep up.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as emby from '../api/emby'
import type { User } from '../api/types'
import { useUser } from '../auth'

const keys = {
    activity: ['manage', 'activity'] as const,
    pulse: ['manage', 'pulse'] as const,
    userActivity: (uid: string) => ['manage', 'activity', uid] as const,
    users: ['manage', 'users'] as const,
    sessions: ['manage', 'sessions'] as const,
    devices: ['manage', 'devices'] as const,
    counts: ['manage', 'counts'] as const,
    watching: (uid: string) => ['manage', 'watching', uid] as const,
    favorites: (uid: string) => ['manage', 'favorites', uid] as const,
}

export const useUsers = () =>
    useQuery({ queryKey: keys.users, queryFn: emby.users, staleTime: 0, refetchInterval: 30_000 })
export const useSessions = () =>
    useQuery({ queryKey: keys.sessions, queryFn: emby.sessions, staleTime: 0, refetchInterval: 10_000 })
export const useDevices = () =>
    useQuery({ queryKey: keys.devices, queryFn: async () => (await emby.devices()).Items, staleTime: 0 })

const PAGE = 60

export function useActivity() {
    return useInfiniteQuery({
        queryKey: keys.activity,
        queryFn: ({ pageParam }) => emby.activity({ StartIndex: pageParam, Limit: PAGE }),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => {
            const loaded = pages.reduce((n, p) => n + p.Items.length, 0)
            return loaded < last.TotalRecordCount && last.Items.length > 0 ? loaded : undefined
        },
        staleTime: 0,
        refetchInterval: 30_000,
    })
}

/** The last day of activity, for the pulse and the latest entries. */
export function usePulse() {
    return useQuery({
        queryKey: keys.pulse,
        queryFn: async () =>
            (await emby.activity({ MinDate: new Date(Date.now() - 24 * 3600_000).toISOString(), Limit: 500 })).Items,
        staleTime: 0,
        refetchInterval: 30_000,
    })
}

export function useUserActivity(uid: string | undefined) {
    return useQuery({
        queryKey: keys.userActivity(uid ?? ''),
        queryFn: async () => (await emby.activity({ UserId: uid, Limit: 30 })).Items,
        enabled: !!uid,
        staleTime: 0,
    })
}

export function useCounts() {
    const me = useUser()
    return useQuery({ queryKey: keys.counts, queryFn: () => emby.counts(me.Id), staleTime: 5 * 60_000 })
}

/** What someone would continue: an administrator naming a user id sees that user's own state. */
export function useWatching(uid: string | undefined) {
    return useQuery({
        queryKey: keys.watching(uid ?? ''),
        queryFn: async () => (await emby.resume(uid ?? '', { Limit: 24, IncludeNextUp: true })).Items,
        enabled: !!uid,
        staleTime: 0,
    })
}

export function useFavoritesOf(uid: string | undefined) {
    return useQuery({
        queryKey: keys.favorites(uid ?? ''),
        queryFn: async () =>
            (
                await emby.items(uid ?? '', {
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Movie,Series,BoxSet,Video',
                    Recursive: true,
                })
            ).Items,
        enabled: !!uid,
        staleTime: 0,
    })
}

function useRefresh() {
    const qc = useQueryClient()
    return () => qc.invalidateQueries({ queryKey: ['manage'] })
}

export function useCreateUser() {
    const refresh = useRefresh()
    return useMutation({
        mutationFn: ({ name, password }: { name: string; password: string }) => emby.createUser(name, password),
        onSuccess: refresh,
    })
}

export function useDeleteUser() {
    const refresh = useRefresh()
    return useMutation({ mutationFn: (u: User) => emby.deleteUser(u.Id), onSuccess: refresh })
}

export function useSetPolicy() {
    const refresh = useRefresh()
    return useMutation({
        mutationFn: ({ uid, policy }: { uid: string; policy: { IsAdministrator?: boolean; IsDisabled?: boolean } }) =>
            emby.setPolicy(uid, policy),
        onSuccess: refresh,
    })
}

export function useResetPassword() {
    const refresh = useRefresh()
    return useMutation({
        mutationFn: ({ uid, password }: { uid: string; password: string }) => emby.resetPassword(uid, password),
        onSuccess: refresh,
    })
}

export function useRenameUser() {
    const refresh = useRefresh()
    return useMutation({
        mutationFn: ({ uid, name }: { uid: string; name: string }) => emby.renameUser(uid, name),
        onSuccess: refresh,
    })
}

export function useImportUpstream() {
    const refresh = useRefresh()
    return useMutation({ mutationFn: (uid: string) => emby.importUpstream(uid), onSuccess: refresh })
}

export function useDeleteDevice() {
    const refresh = useRefresh()
    return useMutation({ mutationFn: (id: string) => emby.deleteDevice(id), onSuccess: refresh })
}

/** Eight easy characters in two groups, without the letters and digits people misread. */
export function generatePassword(): string {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const chars = [...bytes].map(b => alphabet[b % alphabet.length])
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}
