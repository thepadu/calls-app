import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Session } from 'sip.js';
import { apiFetch } from './api';
import { useSoftphone } from './softphone';
import { useToast } from './toast';

type Call = {
    session_id: string;
    caller: string;
    created_at: string;
    add_party_status?: 'requested' | 'dialing' | 'connected' | 'left' | 'failed' | null;
};

const ActiveCallContext = createContext<{
    activeCall: Call | null;
    lastCall: Call | null;
    agentStatus: string | null;
    justEnded: boolean;
    dismissJustEnded: () => void;
    triggerWrapUp: () => void;
    quickTicketOpen: boolean;
    openQuickTicket: () => void;
    closeQuickTicket: () => void;
}>({
    activeCall: null,
    lastCall: null,
    agentStatus: null,
    justEnded: false,
    dismissJustEnded: () => {},
    triggerWrapUp: () => {},
    quickTicketOpen: false,
    openQuickTicket: () => {},
    closeQuickTicket: () => {}
});

// Polls the logged-in agent's own call status. There's no way to push this
// from the server without real-time infra (see SYSTEM_DESIGN.md's
// scalability notes), so this is a plain 5s poll like everything else.
export function ActiveCallProvider({ children }: { children: ReactNode }) {
    const { data, dataUpdatedAt } = useQuery({
        queryKey: ['active-call'],
        queryFn: () => apiFetch('/api/agents/me/active-call'),
        refetchInterval: 5000
    });

    const [justEnded, setJustEnded] = useState(false);
    const [lastCall, setLastCall] = useState<Call | null>(null);
    const [quickTicketOpen, setQuickTicketOpen] = useState(false);
    const wasOnCall = useRef(false);

    const activeCall: Call | null = data?.call ?? null;
    const agentStatus: string | null = data?.agentStatus ?? null;
    const isOnCall = agentStatus === 'on_call';

    useEffect(() => {
        if (activeCall) setLastCall(activeCall);
    }, [activeCall]);

    useEffect(() => {
        if (wasOnCall.current && !isOnCall) setJustEnded(true);
        wasOnCall.current = isOnCall;
    }, [isOnCall]);

    // Server-truth reconciliation: the softphone's own local session state
    // can get stuck reporting a call as live (e.g. still "on hold") after a
    // disruptive event — a backgrounded/killed mobile tab that never
    // received the real BYE — with nothing in that hook itself able to
    // detect it's stale. This poll is the one thing that reliably knows the
    // real state, so a sustained disagreement forces the local side to
    // defer to it rather than adding another special case to softphone.tsx.
    // Requires 2 consecutive polls (~10s) of disagreement, not 1, so this
    // can't misfire in the brief legitimate window right after a real call
    // first connects, before ari-app's own status flip has propagated here.
    //
    // "Legitimate" is an OR of two signals, either is enough:
    //  - `activeCall` (this row now includes 'dialing', not just 'ongoing'
    //    — see GET /api/agents/me/active-call) covers the *caller* side of
    //    a call still ringing out: their own leg answers immediately, well
    //    before the real destination picks up and agentStatus flips.
    //  - `agentStatus === 'on_call'` covers the *callee* side of an
    //    internal agent-to-agent call: no call_logs row is ever attributed
    //    to them, but ari-app does flip their own agentStatus once bridged.
    // A genuinely stuck/ghost call has neither — the real call's own
    // server-side cleanup reverts agentStatus independently of whatever
    // the client's browser is doing, so this doesn't weaken the original
    // ghost-detection.
    const softphone = useSoftphone();
    const showToast = useToast();
    const mismatchStreakRef = useRef(0);
    // The streak above must belong to one specific call — otherwise a
    // leftover mismatch tick from a call that just ended can combine with
    // a freshly-redialed call's own brief startup window and trip the
    // threshold against a call with no real stuck time of its own.
    const trackedSessionRef = useRef<Session | null>(null);

    useEffect(() => {
        if (!dataUpdatedAt) return;
        const liveSession = softphone.activeCall?.session ?? softphone.outgoingCall?.session ?? softphone.incomingCall?.session ?? null;
        const localCallLive = !!liveSession;
        const serverSaysNoCall = !activeCall && agentStatus !== 'on_call';

        if (liveSession !== trackedSessionRef.current) {
            trackedSessionRef.current = liveSession;
            mismatchStreakRef.current = 0;
        }

        if (localCallLive && serverSaysNoCall) {
            mismatchStreakRef.current += 1;
            if (mismatchStreakRef.current >= 2) {
                mismatchStreakRef.current = 0;
                softphone.forceLocalReset();
                showToast('Cleared a stuck call — the server no longer shows it as active', 'error');
            }
        } else {
            mismatchStreakRef.current = 0;
        }
        // softphone/showToast are stable-enough function identities from
        // their own providers, but not included here deliberately — this
        // effect must fire on every poll tick (dataUpdatedAt), not
        // whenever a fresh function reference happens to be created.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataUpdatedAt, activeCall, agentStatus]);

    return (
        <ActiveCallContext.Provider
            value={{
                activeCall,
                lastCall,
                agentStatus,
                justEnded,
                dismissJustEnded: () => setJustEnded(false),
                // Lets the "E" keyboard shortcut open wrap-up early, before
                // the natural on_call → available transition is detected.
                triggerWrapUp: () => setJustEnded(true),
                quickTicketOpen,
                openQuickTicket: () => setQuickTicketOpen(true),
                closeQuickTicket: () => setQuickTicketOpen(false)
            }}
        >
            {children}
        </ActiveCallContext.Provider>
    );
}

export function useActiveCall() {
    return useContext(ActiveCallContext);
}
