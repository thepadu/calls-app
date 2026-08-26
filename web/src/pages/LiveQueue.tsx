import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { formatDuration as formatWait } from '../lib/duration';
import ConfirmDialog from '../components/ConfirmDialog';

type QueuedCall = {
    session_id: string;
    caller: string;
    waitSeconds: number;
    stage: 'Waiting' | 'In Menu';
};

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
}

// SLA coloring only applies once a caller is actually on hold — someone
// still navigating the IVR menu isn't "late" yet.
function waitRowClass(call: QueuedCall) {
    if (call.stage !== 'Waiting') return '';
    if (call.waitSeconds >= 90) return 'live-row queue-row-danger';
    if (call.waitSeconds >= 60) return 'queue-row-warning';
    return '';
}

export default function LiveQueue() {
    const { isSupervisor } = useAuth();
    const showToast = useToast();
    const queryClient = useQueryClient();
    const [pendingClear, setPendingClear] = useState<QueuedCall | null>(null);

    // No refetchInterval here — GlobalPolling (mounted once in Layout, see
    // lib/globalPolling.tsx) already owns both of these keys. Adding a
    // second independent interval on this page doesn't get deduped: two
    // observers mounted at different times fire their timers out of phase,
    // roughly doubling actual traffic while this page is open. This still
    // gets live updates for free, since every observer of the same cache
    // entry re-renders whenever GlobalPolling's fetch refreshes it.
    const { data: queueData, isLoading: queueLoading } = useQuery({
        queryKey: ['queue'],
        queryFn: () => apiFetch('/api/queue')
    });

    const { data: countData } = useQuery({
        queryKey: ['agents-available-count'],
        queryFn: () => apiFetch('/api/agents/available-count')
    });

    const calls: QueuedCall[] = queueData?.calls ?? [];
    const stats = queueData?.stats ?? { inQueue: 0, avgWaitSeconds: 0, longestWaitSeconds: 0 };

    // A stuck row normally clears itself (a real hangup, or ari-app's
    // periodic stale-call sweep for an orphaned one) — this is strictly a
    // supervisor escape hatch for "I can see this isn't real, don't make me
    // wait out the sweep interval," not a general call-control action.
    const clearCall = useMutation({
        mutationFn: (sessionId: string) => apiFetch(`/api/calls/${sessionId}/mark-failed`, { method: 'POST' }),
        onSuccess: () => {
            showToast('Call cleared');
            queryClient.invalidateQueries({ queryKey: ['queue'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error'),
        onSettled: () => setPendingClear(null)
    });

    return (
        <div>
            <div className="cards">
                <div className="card">
                    <div className="card-label">In Queue</div>
                    <p>{stats.inQueue}</p>
                </div>
                <div className="card">
                    <div className="card-label">Avg Wait</div>
                    <p>{formatWait(stats.avgWaitSeconds)}</p>
                </div>
                <div className="card">
                    <div className="card-label">Longest Wait</div>
                    <p>{formatWait(stats.longestWaitSeconds)}</p>
                </div>
                <div className="card">
                    <div className="card-label">Agents Available</div>
                    <p>{countData?.count ?? '—'}</p>
                </div>
            </div>

            <div className="panel">
                <p className="hint">
                    Waiting callers ring every available agent's browser at once — first to answer gets
                    the call. This page is mainly for visibility into who's waiting
                    {isSupervisor && ' — supervisors can also clear a call that\'s no longer real'}.
                </p>

                <table>
                    <thead>
                        <tr>
                            <th>Caller</th>
                            <th>Stage</th>
                            <th>Wait</th>
                            {isSupervisor && <th></th>}
                        </tr>
                    </thead>
                    <tbody>
                        {calls.length === 0 && !queueLoading && (
                            <tr><td colSpan={isSupervisor ? 4 : 3} className="empty">Queue is empty. All callers answered.</td></tr>
                        )}
                        {calls.map(call => (
                            <tr key={call.session_id} className={waitRowClass(call)}>
                                <td>{call.caller}</td>
                                <td>
                                    <span className={call.stage === 'Waiting' ? 'stage-badge stage-waiting' : 'stage-badge stage-in-menu'}>
                                        {call.stage}
                                    </span>
                                </td>
                                <td style={{ fontWeight: 700 }}>{formatWait(call.waitSeconds)}</td>
                                {isSupervisor && (
                                    <td>
                                        <button className="btn btn-link btn-link-danger" onClick={() => setPendingClear(call)}>
                                            Mark as ended
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <ConfirmDialog
                open={!!pendingClear}
                title="Mark call as ended"
                message={`Mark ${pendingClear?.caller}'s call as ended? Only do this if the call isn't actually real anymore — e.g. it's been stuck showing here well past a normal wait.`}
                confirmLabel="Mark as ended"
                danger
                onConfirm={() => pendingClear && clearCall.mutate(pendingClear.session_id)}
                onCancel={() => setPendingClear(null)}
            />
        </div>
    );
}
