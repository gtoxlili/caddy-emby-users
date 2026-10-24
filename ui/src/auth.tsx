// Sign-in state: the token lives in localStorage, the user in memory, fetched again with
// the token on every start (which also checks the token). Any 401 sends the person back to
// the sign-in page, as Emby's own clients do.

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getToken, onSignedOut, setToken } from './api/client'
import * as emby from './api/emby'
import type { User } from './api/types'
import { queryClient } from './query'

export interface AuthState {
    /** undefined while an earlier token is being checked; null when signed out. */
    user: User | null | undefined
    login: (name: string, password: string) => Promise<User>
    logout: () => Promise<void>
    refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)
const UID_KEY = 'emby-users.uid'

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null | undefined>(getToken() ? undefined : null)

    const drop = useCallback(() => {
        setToken(null)
        localStorage.removeItem(UID_KEY)
        queryClient.clear()
        setUser(null)
    }, [])

    useEffect(() => onSignedOut(drop), [drop])

    const refresh = useCallback(async () => {
        const uid = localStorage.getItem(UID_KEY)
        if (!getToken() || !uid) {
            setUser(null)
            return
        }
        try {
            setUser(await emby.me(uid))
        } catch {
            // A 401 has already signed out. Anything else (offline) keeps the unknown state.
            if (!getToken()) setUser(null)
        }
    }, [])

    useEffect(() => {
        if (getToken()) void refresh()
    }, [refresh])

    const login = useCallback(async (name: string, password: string) => {
        const r = await emby.login(name, password)
        setToken(r.AccessToken)
        localStorage.setItem(UID_KEY, r.User.Id)
        setUser(r.User)
        return r.User
    }, [])

    const logout = useCallback(async () => {
        try {
            await emby.logout()
        } catch {
            // An expired token signs out just the same.
        }
        drop()
    }, [drop])

    const value = useMemo(() => ({ user, login, logout, refresh }), [user, login, logout, refresh])
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth needs an AuthProvider')
    return ctx
}

/** For signed-in pages, where the user always exists. */
export function useUser(): User {
    const { user } = useAuth()
    if (!user) throw new Error('useUser is only for signed-in pages')
    return user
}
