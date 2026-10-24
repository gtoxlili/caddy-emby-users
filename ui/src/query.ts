import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api/error'

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // A minute without asking again keeps page switches from flashing; play state is
            // refetched explicitly where it matters.
            staleTime: 60_000,
            gcTime: 10 * 60_000,
            retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
            refetchOnWindowFocus: false,
        },
    },
})
