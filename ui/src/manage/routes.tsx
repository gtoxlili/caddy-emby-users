import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { useAuth } from '../auth'
import { House } from '../light/room'
import { Button } from '../ui/button'
import Activity from './activity'
import Devices from './devices'
import Overview from './overview'
import { ManageShell } from './shell'
import UserPage from './user'
import Users from './users'

/** Management for administrators; everyone else is told so and sent back to the films. */
export default function Manage() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    if (!user?.Policy.IsAdministrator) {
        return (
            <main className="grid min-h-svh place-items-center p-8 text-center">
                <House />
                <div className="glass grid max-w-[26em] gap-4 rounded-panel p-7">
                    <h1 className="font-display text-[26px]">这里只给管理员</h1>
                    <p className="text-[14px] text-(--text-2) text-pretty">
                        {user?.Name}，你的账号能看片，但不能管理别人的账号。
                    </p>
                    <div className="flex justify-center gap-2">
                        <Button variant="ghost" onClick={() => logout()}>
                            换个账号
                        </Button>
                        <Button variant="bright" onClick={() => navigate('/', { viewTransition: true })}>
                            回去看片
                        </Button>
                    </div>
                </div>
            </main>
        )
    }
    return (
        <ManageShell>
            <Routes>
                <Route index element={<Overview />} />
                <Route path="users" element={<Users />} />
                <Route path="users/:uid" element={<UserPage />} />
                <Route path="devices" element={<Devices />} />
                <Route path="activity" element={<Activity />} />
                <Route path="*" element={<Navigate to="/manage" replace />} />
            </Routes>
        </ManageShell>
    )
}
