import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { apiFetch } from '../lib/api';
import CallsByHourChart from '../components/CallsByHourChart';
import Pagination from '../components/Pagination';
import StatusPill from '../components/StatusPill';

type Summary = {
    total: number;
    login: number;
    deposit: number;
    agentRequests: number;
    outbound: number;
    missed: number;
    missedByReason: { abandoned: number; forwarded: number; afterHours: number };
};

type AgentStat = { id: number | null; name: string; total: number; answered: number; missed: number; avgHandleTime: number };

type StatusCounts = { available: number; on_call: number; ringing: number; break: number; offline: number };

type TicketStats = { total: number; resolved: number; byTag: Record<string, number>; byPriority: Record<string, number> };

const STATUS_LABELS: Record<keyof StatusCounts, string> = {
    available: 'Available',
    on_call: 'On call',
    ringing: 'Ringing',
    break: 'On break',
    offline: 'Offline'
};

const PAGE_SIZE = 10;

function todayISO() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function Analytics() {
    const today = useMemo(todayISO, []);
    const [statsPage, setStatsPage] = useState(1);

    const { data: callsData, isLoading: callsLoading } = useQuery({
        queryKey: ['analytics-calls', today],
        queryFn: () => apiFetch(`/api/calls?from=${today}&to=${today}`),
        refetchInterval: 30000
    });

    const { data: hourData, isLoading: hourLoading } = useQuery({
        queryKey: ['calls-by-hour'],
        queryFn: () => apiFetch('/api/calls/by-hour'),
        refetchInterval: 60000
    });

    const { data: statsData, isLoading: statsLoading } = useQuery({
        queryKey: ['agents-stats-full'],
        queryFn: () => apiFetch('/api/agents/stats'),
        refetchInterval: 30000
    });

    const { data: statusSummaryData, isLoading: statusLoading } = useQuery({
        queryKey: ['agents-status-summary'],
        queryFn: () => apiFetch('/api/agents/status-summary'),
        refetchInterval: 15000
    });

    const { data: ticketStatsData, isLoading: ticketsLoading } = useQuery({
        queryKey: ['tickets-stats'],
        queryFn: () => apiFetch('/api/tickets/stats'),
        refetchInterval: 30000
    });

    // First paint with none of the five queries resolved yet looked
    // identical to "this dashboard genuinely has no data" — every card a
    // dash, every panel showing its own empty state. Gating on the initial
    // load specifically (not every refetch — the 15-30s auto-refreshes
    // shouldn't blank the page every time) fixes the first impression
    // without touching each card's individual '—' fallback.
    const initialLoading = callsLoading && hourLoading && statsLoading && statusLoading && ticketsLoading;

    const summary: Summary | undefined = callsData?.summary;
    const agentStats: AgentStat[] = useMemo(() => statsData?.agents ?? [], [statsData]);
    const statusCounts: StatusCounts | undefined = statusSummaryData?.counts;
    const ticketStats: TicketStats | undefined = ticketStatsData;
    const totalAgents = statusCounts ? Object.values(statusCounts).reduce((sum, n) => sum + n, 0) : 0;

    const ranked = useMemo(() => [...agentStats].sort((a, b) => b.answered - a.answered), [agentStats]);
    const totalPages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
    const pageOfStats = ranked.slice((statsPage - 1) * PAGE_SIZE, statsPage * PAGE_SIZE);

    const avgHandleTimeAll = useMemo(() => {
        const withCalls = agentStats.filter(a => a.answered > 0);
        if (!withCalls.length) return 0;
        return Math.round(withCalls.reduce((sum, a) => sum + a.avgHandleTime, 0) / withCalls.length);
    }, [agentStats]);

    if (initialLoading) {
        return (
            <div>
                <p className="empty">Loading analytics…</p>
            </div>
        );
    }

    return (
        <div>
            <p className="hint" style={{ marginTop: 0 }}>
                Today, {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>

            <div className="cards">
                <div className="card">
                    <div className="card-label">Total Calls</div>
                    <p>{summary?.total ?? '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Incoming</div>
                    <p>{summary ? summary.total - summary.outbound : '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Outgoing</div>
                    <p>{summary?.outbound ?? '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Login Issues</div>
                    <p>{summary?.login ?? '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Deposit Issues</div>
                    <p>{summary?.deposit ?? '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Agent Requests</div>
                    <p>{summary?.agentRequests ?? '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Missed</div>
                    <p>{summary?.missed ?? '—'}</p>
                </div>
                <div className="card">
                    <div className="card-label">Team Avg Handle Time (all-time)</div>
                    <p>{avgHandleTimeAll}s</p>
                </div>
            </div>

            <CallsByHourChart hours={hourData?.hours ?? []} isLoading={hourLoading} />

            <div className="panel">
                <h3>Missed calls, by reason</h3>
                <p className="hint">Today only — see the Calls page for the full history.</p>
                <div className="analytics-row">
                    <span>Abandoned before an agent answered</span>
                    <strong>{summary?.missedByReason.abandoned ?? 0}</strong>
                </div>
                <div className="analytics-row">
                    <span>Forwarded (nobody was online)</span>
                    <strong>{summary?.missedByReason.forwarded ?? 0}</strong>
                </div>
                <div className="analytics-row">
                    <span>Outside business hours</span>
                    <strong>{summary?.missedByReason.afterHours ?? 0}</strong>
                </div>
            </div>

            <div className="panel">
                <h3>Team status right now</h3>
                {statusCounts && totalAgents === 0 && <p className="empty">No agents on the roster yet.</p>}
                {statusCounts &&
                    totalAgents > 0 &&
                    (Object.keys(STATUS_LABELS) as (keyof StatusCounts)[]).map(key => (
                        <div className="analytics-row" key={key}>
                            <StatusPill value={key} label={STATUS_LABELS[key]} />
                            <strong>{statusCounts[key]}</strong>
                        </div>
                    ))}
            </div>

            <div className="panel">
                <h3>Tickets</h3>
                {ticketStats && ticketStats.total === 0 && <p className="empty">No tickets logged yet.</p>}
                {ticketStats && ticketStats.total > 0 && (
                    <>
                        <div className="analytics-row">
                            <span>Resolution rate</span>
                            <strong>{Math.round((ticketStats.resolved / ticketStats.total) * 100)}%</strong>
                        </div>
                        <p className="hint analytics-section-label">By tag</p>
                        {Object.entries(ticketStats.byTag).map(([tag, count]) => (
                            <div className="analytics-row" key={tag}>
                                <span>{tag}</span>
                                <strong>{count}</strong>
                            </div>
                        ))}
                        <p className="hint analytics-section-label">By priority</p>
                        {Object.entries(ticketStats.byPriority).map(([priority, count]) => (
                            <div className="analytics-row" key={priority}>
                                <span>{priority}</span>
                                <strong>{count}</strong>
                            </div>
                        ))}
                    </>
                )}
            </div>

            <div className="panel">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Trophy size={18} /> Agent performance (all-time)</h3>
                {ranked.length === 0 && <p className="empty">No agent call data yet.</p>}
                {ranked.length > 0 && (
                    <>
                        <table className="agent-stats-table">
                            <thead>
                                <tr>
                                    <th>Rank</th>
                                    <th>Agent</th>
                                    <th>Total Calls</th>
                                    <th>Answered</th>
                                    <th>Missed</th>
                                    <th>Avg Handle Time</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pageOfStats.map((a, i) => (
                                    <tr key={a.id ?? a.name}>
                                        <td style={{ color: 'var(--muted)', fontWeight: 700 }}>
                                            {(statsPage - 1) * PAGE_SIZE + i + 1}
                                        </td>
                                        <td>{a.name}</td>
                                        <td>{a.total}</td>
                                        <td>{a.answered}</td>
                                        <td>{a.missed}</td>
                                        <td>{a.avgHandleTime}s</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {/* Same reasoning as .calls-mobile-list/.tickets-mobile-list — a
                            6-column table with no mobile presentation, found live: Missed
                            and Avg Handle Time fell off a 375px viewport. */}
                        <div className="agent-stats-mobile-list">
                            {pageOfStats.map((a, i) => (
                                <div className="agent-stat-card" key={a.id ?? a.name}>
                                    <div className="agent-stat-card-top">
                                        <span className="agent-stat-card-rank">{(statsPage - 1) * PAGE_SIZE + i + 1}</span>
                                        <span className="agent-stat-card-name">{a.name}</span>
                                    </div>
                                    <div className="agent-stat-card-grid">
                                        <div><span className="hint">Total</span><br />{a.total}</div>
                                        <div><span className="hint">Answered</span><br />{a.answered}</div>
                                        <div><span className="hint">Missed</span><br />{a.missed}</div>
                                        <div><span className="hint">Avg handle</span><br />{a.avgHandleTime}s</div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <Pagination page={statsPage} totalPages={totalPages} onPageChange={setStatsPage} total={ranked.length} pageSize={PAGE_SIZE} />
                    </>
                )}
            </div>
        </div>
    );
}
