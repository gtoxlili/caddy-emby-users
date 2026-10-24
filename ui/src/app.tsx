import type { ComponentType, ReactNode } from 'react'
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from './auth'
import { Shell } from './components/shell'
import { Login } from './pages/login'
import { Loading } from './ui/spinner'

/** Route-level code splitting: the module arrives before the state changes, so a view transition never shows a loading state. */
function page(load: () => Promise<{ default: ComponentType }>) {
    return { lazy: async () => ({ Component: (await load()).default }) }
}

function Guard({ children }: { children: ReactNode }) {
    const { user } = useAuth()
    const location = useLocation()
    if (user === undefined) return <Loading className="min-h-svh" />
    if (user === null) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
    return <>{children}</>
}

export const router = createBrowserRouter(
    [
        { path: '/login', element: <Login /> },
        {
            element: (
                <Guard>
                    <Outlet />
                </Guard>
            ),
            hydrateFallbackElement: <Loading className="min-h-svh" />,
            children: [
                { path: '/play/:id', ...page(() => import('./pages/player')) },
                { path: '/manage/*', ...page(() => import('./manage/routes')) },
                {
                    element: <Shell />,
                    children: [
                        { index: true, ...page(() => import('./pages/home')) },
                        { path: 'library/:id?', ...page(() => import('./pages/library')) },
                        { path: 'item/:id', ...page(() => import('./pages/item')) },
                        { path: 'person/:id', ...page(() => import('./pages/person')) },
                        { path: 'search', ...page(() => import('./pages/search')) },
                        { path: 'me', ...page(() => import('./pages/me')) },
                        { path: '*', element: <Navigate to="/" replace /> },
                    ],
                },
            ],
        },
    ],
    { basename: '/web' },
)
