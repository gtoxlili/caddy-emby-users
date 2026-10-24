import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { router } from './app'
import { AuthProvider } from './auth'
import { LightProvider } from './light/room'
import { queryClient } from './query'
import { ToastHost } from './ui/toast'
import './styles/app.css'

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
                <LightProvider>
                    <ToastHost>
                        <RouterProvider router={router} />
                    </ToastHost>
                </LightProvider>
            </AuthProvider>
        </QueryClientProvider>
    </StrictMode>,
)
