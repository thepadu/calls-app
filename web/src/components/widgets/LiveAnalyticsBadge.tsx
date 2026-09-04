import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';

export default function LiveAnalyticsBadge() {
    const [open, setOpen] = useState(false);

    const { data } = useQuery({
        queryKey: ['calls-summary'],
        queryFn: () => apiFetch('/api/calls'),
        refetchInterval: 10000,
        enabled: open
    });

    // Same Escape-only convention as TicketDrawer/FloatingDialer — no
    // backdrop, not a modal, just a quick way out for a keyboard user.
    useEffect(() => {
        if (!open) return;
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false);
        }
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open]);

    const summary = data?.summary;

    return (
        <div className="floating-analytics">
            {open && (
                <div className="analytics-popover">
                    <div className="analytics-popover-title">Today at a glance</div>
                    <div className="analytics-row">
                        <span>Calls</span>
                        <strong>{summary?.total ?? '—'}</strong>
                    </div>
                    <div className="analytics-row">
                        <span>Agent requests</span>
                        <strong>{summary?.agentRequests ?? '—'}</strong>
                    </div>
                    <div className="analytics-row">
                        <span>Outgoing</span>
                        <strong>{summary?.outbound ?? '—'}</strong>
                    </div>
                    <div className="analytics-row">
                        <span>Missed</span>
                        <strong className="danger-text">{summary?.missed ?? '—'}</strong>
                    </div>
                </div>
            )}
            <button
                className="fab fab-analytics"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                aria-label="Today's stats"
            >
                <span aria-hidden="true">📊</span> Today's Stats
            </button>
        </div>
    );
}
