import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Menu, Sun, Moon } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { useAuth } from '../../lib/auth';
import { useSoftphone, RegistrationState } from '../../lib/softphone';
import MyStatusControl from '../widgets/MyStatusControl';

const TITLES: Record<string, string> = {
    '/': 'Dashboard',
    '/queue': 'Live Queue',
    '/calls': 'Calls',
    '/tickets': 'Tags & Tickets',
    '/analytics': 'Analytics',
    '/agents': 'Agents',
    '/ivr': 'IVR Builder',
    '/settings': 'Settings'
};

// A dropped SIP connection previously only ever surfaced as a toast an
// agent could easily miss mid-call, or a failed dial attempt — this makes
// it something they can glance at and confirm at any time.
const CONNECTION_LABELS: Record<RegistrationState, string> = {
    registered: 'Connected',
    registering: 'Connecting…',
    unregistered: 'Reconnecting…',
    failed: 'Disconnected'
};

const CONNECTION_COLORS: Record<RegistrationState, string> = {
    registered: 'var(--brand)',
    registering: 'var(--warning)',
    unregistered: 'var(--warning)',
    failed: 'var(--danger)'
};

export default function Topbar({ onMenuClick, menuOpen }: { onMenuClick: () => void; menuOpen: boolean }) {
    const location = useLocation();
    const { darkMode, toggleDarkMode } = useTheme();
    const { user } = useAuth();
    const { registrationState } = useSoftphone();

    // GlobalPolling (mounted once in Layout) owns the actual refetch
    // interval for this key — this just reads whatever's in the cache and
    // re-renders when it refreshes.
    const { data } = useQuery({
        queryKey: ['agents-available-count'],
        queryFn: () => apiFetch('/api/agents/available-count')
    });

    const title = TITLES[location.pathname] ?? 'Chumz Support';

    return (
        <header className="topbar">
            <div className="topbar-left">
                <button
                    className="topbar-menu-btn"
                    onClick={onMenuClick}
                    aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                    aria-expanded={menuOpen}
                >
                    <Menu size={20} />
                </button>
                <div className="topbar-title">{title}</div>
            </div>
            <div className="topbar-right">
                <div className="topbar-badge">
                    <span className="topbar-badge-dot" />
                    {data?.count ?? '—'} agents live
                </div>
                {user?.agentId && (
                    <span
                        className="status-pill topbar-connection-pill"
                        style={{ background: CONNECTION_COLORS[registrationState] }}
                        title="Your browser softphone's connection to the phone system"
                    >
                        {CONNECTION_LABELS[registrationState]}
                    </span>
                )}
                <MyStatusControl />
                <button className="topbar-theme-toggle" onClick={toggleDarkMode} title="Toggle night shift theme" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {darkMode ? <><Sun size={16} /> Light</> : <><Moon size={16} /> Night shift</>}
                </button>
            </div>
        </header>
    );
}
