import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { apiFetch } from '../../lib/api';

function initials(name: string) {
    return name
        .split(' ')
        .map(w => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
}

type SidebarProps = { open: boolean; onClose: () => void };

export default function Sidebar({ open, onClose }: SidebarProps) {
    const { user, isSupervisor } = useAuth();

    // GlobalPolling (mounted once in Layout) owns the actual refetch
    // interval for this key — this just reads whatever's in the cache and
    // re-renders when it refreshes.
    const { data: queueData } = useQuery({
        queryKey: ['queue'],
        queryFn: () => apiFetch('/api/queue')
    });

    const inQueue = queueData?.stats?.inQueue ?? 0;

    return (
        <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
            <div className="sidebar-logo">
                <div className="logo-mark">C</div>
                <span>Chumz</span>
            </div>

            {/* One handler on the nav catches every link click via bubbling
                — closes the mobile drawer on navigation without wiring
                onClick into each individual NavLink. */}
            <nav className="sidebar-nav" onClick={onClose}>
                <NavLink to="/" end className="sidebar-link">
                    Dashboard
                </NavLink>
                <NavLink to="/queue" className="sidebar-link">
                    Live Queue
                    {inQueue > 0 && <span className="sidebar-badge">{inQueue}</span>}
                </NavLink>
                <NavLink to="/calls" className="sidebar-link">
                    Calls
                </NavLink>
                <NavLink to="/tickets" className="sidebar-link">
                    Tags &amp; Tickets
                </NavLink>
                <NavLink to="/contacts" className="sidebar-link">
                    Contacts
                </NavLink>
                {isSupervisor && (
                    <>
                        <NavLink to="/analytics" className="sidebar-link">
                            Analytics
                        </NavLink>
                        <NavLink to="/agents" className="sidebar-link">
                            Agents
                        </NavLink>
                        <NavLink to="/ivr" className="sidebar-link">
                            IVR Builder
                        </NavLink>
                        <NavLink to="/settings" className="sidebar-link">
                            Settings
                        </NavLink>
                    </>
                )}
            </nav>

            {user && (
                <div className="sidebar-footer">
                    <div className="sidebar-avatar">{initials(user.name || user.email)}</div>
                    <div className="sidebar-user">
                        <div className="sidebar-user-name">{user.name || user.email}</div>
                        <div className="sidebar-user-role">{user.role === 'supervisor' ? 'Supervisor' : 'Agent'}</div>
                    </div>
                    <a href="/logout" title="Log out" aria-label="Log out" className="sidebar-logout">
                        <LogOut size={18} />
                    </a>
                </div>
            )}
        </aside>
    );
}
