import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSoftphone } from '../lib/softphone';
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
    const { registrationState, activeCall, outgoingCall, incomingCall } = useSoftphone();
    const showToast = useToast();
    const queryClient = useQueryClient();
    const [pendingClear, setPendingClear] = useState<QueuedCall | null>(null);
    const [claimingSessionId, setClaimingSessionId] = useState<string | null>(null);

    // Same busy-guard startOutgoingCall already applies before placing a
    // call — claiming while on/ringing another call would try to originate
    // a second leg to a softphone that can't take it.
    const canClaim = registrationState === 'registered' && !activeCall && !outgoingCall && !incomingCall;

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

    // Tries a real hangup on Asterisk first (see the backend route) — a
    // stuck-looking row usually clears itself on its own, but a supervisor
    // shouldn't have to wait when they can see with their own eyes it isn't
    // real anymore, or need to actually force-end a call that's gone wrong.
    const clearCall = useMutation({
        mutationFn: (sessionId: string) => apiFetch(`/api/calls/${sessionId}/mark-failed`, { method: 'POST' }),
        onSuccess: (data: { realCallEnded: boolean; reason?: string }) => {
            showToast(data.realCallEnded ? 'Call ended' : (data.reason ?? 'Row cleared'));
            queryClient.invalidateQueries({ queryKey: ['queue'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error'),
        onSettled: () => setPendingClear(null)
    });

    // The actual call arrives through the normal incoming-call path (a real
    // originate to this agent's endpoint, same as a ring-all win) — this
    // just kicks that off. A 409 here is a normal lost race (someone else
    // already took it, or the caller hung up), not a real error.
    const claimCall = useMutation({
        mutationFn: (sessionId: string) => apiFetch(`/api/queue/${sessionId}/claim`, { method: 'POST' }),
        onSuccess: () => {
            showToast('Ringing your softphone…');
            queryClient.invalidateQueries({ queryKey: ['queue'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error'),
        onSettled: () => setClaimingSessionId(null)
    });

    function handleClaim(call: QueuedCall) {
        setClaimingSessionId(call.session_id);
        claimCall.mutate(call.session_id);
    }

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
                    the call. You can also pick up a specific caller yourself instead of waiting to be rung
                    {isSupervisor && ', and end a call from here if something has gone wrong'}.
                </p>

                <table>
                    <thead>
                        <tr>
                            <th>Caller</th>
                            <th>Stage</th>
                            <th>Wait</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {calls.length === 0 && !queueLoading && (
                            <tr><td colSpan={4} className="empty">Queue is empty. All callers answered.</td></tr>
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
                                <td style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                    {call.stage === 'Waiting' && (
                                        <button
                                            className="btn btn-link"
                                            disabled={!canClaim || claimingSessionId === call.session_id}
                                            title={canClaim ? undefined : "You're not available to take calls right now"}
                                            onClick={() => handleClaim(call)}
                                        >
                                            Pick up
                                        </button>
                                    )}
                                    {isSupervisor && (
                                        <button className="btn btn-link btn-link-danger" onClick={() => setPendingClear(call)}>
                                            End call
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <ConfirmDialog
                open={!!pendingClear}
                title="End this call"
                message={`End ${pendingClear?.caller}'s call? If it's genuinely still live, this actually hangs it up for the agent and caller — not just a database correction. Use this for a call stuck here past a normal wait, or one that needs to be force-ended.`}
                confirmLabel="End call"
                danger
                onConfirm={() => pendingClear && clearCall.mutate(pendingClear.session_id)}
                onCancel={() => setPendingClear(null)}
            />
        </div>
    );
}
