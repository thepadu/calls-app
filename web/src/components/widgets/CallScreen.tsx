import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff, Mic, MicOff, Pause, Play, UserPlus, Ticket as TicketIcon, X, Volume2, Speaker } from 'lucide-react';
import { useSoftphone } from '../../lib/softphone';
import { useActiveCall } from '../../lib/activeCall';
import { apiFetch } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { formatPhone, isValidPhone } from '../../lib/phoneFormat';
import { formatDuration } from '../../lib/duration';
import TicketDrawer from './TicketDrawer';

// Browsers block audio autoplay until the page has seen at least one user
// gesture this session. Agents are usually already clicking around the
// dashboard before a call comes in, so this is mostly a formality — but if a
// call rings on a freshly-loaded, untouched tab, we skip the (blocked)
// ringtone and fall back to a purely visual cue instead of a silently
// swallowed error.
function useHasUserGestured() {
    const [gestured, setGestured] = useState(false);

    useEffect(() => {
        if (gestured) return;
        const onGesture = () => setGestured(true);
        window.addEventListener('pointerdown', onGesture, { once: true });
        window.addEventListener('keydown', onGesture, { once: true });
        return () => {
            window.removeEventListener('pointerdown', onGesture);
            window.removeEventListener('keydown', onGesture);
        };
    }, [gestured]);

    return gestured;
}

// Synthesized via Web Audio (two alternating tones, classic ring cadence)
// rather than shipping an audio file — one less asset to deploy/host.
function useRingtone(playing: boolean) {
    const audioCtxRef = useRef<AudioContext | null>(null);
    const stopRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!playing) {
            stopRef.current?.();
            stopRef.current = null;
            return;
        }

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        let cancelled = false;
        let timeoutId: number;

        function ringOnce() {
            if (cancelled) return;
            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const gain = ctx.createGain();
            osc1.frequency.value = 440;
            osc2.frequency.value = 480;
            gain.gain.value = 0.15;
            osc1.connect(gain);
            osc2.connect(gain);
            gain.connect(ctx.destination);
            osc1.start();
            osc2.start();
            osc1.stop(ctx.currentTime + 1);
            osc2.stop(ctx.currentTime + 1);
            timeoutId = window.setTimeout(ringOnce, 3000);
        }
        ringOnce();

        stopRef.current = () => {
            cancelled = true;
            clearTimeout(timeoutId);
            ctx.close().catch(() => {});
        };

        return () => stopRef.current?.();
    }, [playing]);
}

// Requested once, right when a call first rings, rather than proactively at
// login — asking for notification permission out of the blue (before the
// agent has any reason to want it) is a common way to get "block" clicked
// reflexively, which then also blocks it for every future call.
function useCallNotification(incomingCall: { callerNumber: string } | null) {
    const shownFor = useRef<string | null>(null);

    useEffect(() => {
        if (!incomingCall) {
            shownFor.current = null;
            return;
        }
        // Only worth interrupting the agent if they're not even looking at
        // this tab — otherwise the call screen itself is enough.
        if (!document.hidden) return;
        if (shownFor.current === incomingCall.callerNumber) return;
        shownFor.current = incomingCall.callerNumber;

        if (!('Notification' in window)) return;

        const show = () => new Notification('Incoming call', { body: incomingCall.callerNumber, tag: 'incoming-call' });

        if (Notification.permission === 'granted') {
            show();
        } else if (Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') show();
            });
        }
    }, [incomingCall]);
}

const ADD_PARTY_LABELS: Record<string, string> = {
    requested: 'Adding party…',
    dialing: 'Adding party…',
    connected: 'Party connected',
    left: 'Party left',
    failed: "Couldn't add party"
};

// One unified "call screen" for all three phases a call can be in
// (incoming/outgoing/active), Android-style — one big always-in-the-same-
// place card whose content and actions change with the phase, rather than
// three separate banners/bars. Deliberately NOT a blocking modal: an agent
// still needs to reach the rest of the dashboard (customer lookups, tickets)
// while on a call, so this is a large floating card with no click-catching
// backdrop — Layout.tsx separately dims the sidebar/topbar for focus.
export default function CallScreen() {
    const {
        incomingCall,
        outgoingCall,
        activeCall: softphoneCall,
        answer,
        reject,
        cancelOutgoingCall,
        toggleMute,
        toggleHold,
        hangup,
        audioOutputSupported,
        speakerOn,
        toggleSpeaker
    } = useSoftphone();
    const { activeCall: polledCall, openQuickTicket, quickTicketOpen } = useActiveCall();
    const hasGestured = useHasUserGestured();
    const originalTitle = useRef(document.title);
    const [seconds, setSeconds] = useState(0);
    const [addPartyOpen, setAddPartyOpen] = useState(false);
    const [addPartyInput, setAddPartyInput] = useState('');
    const showToast = useToast();
    const queryClient = useQueryClient();

    useRingtone(!!incomingCall && hasGestured);
    useCallNotification(incomingCall);

    useEffect(() => {
        const original = originalTitle.current;

        if (!incomingCall) {
            document.title = original;
            return;
        }

        const flashInterval = setInterval(() => {
            document.title = document.title === original ? '📞 Incoming call…' : original;
        }, 1000);

        return () => {
            clearInterval(flashInterval);
            document.title = original;
        };
    }, [incomingCall]);

    const addParty = useMutation({
        mutationFn: (destination: string) =>
            apiFetch('/api/calls/active/add-party', { method: 'POST', body: JSON.stringify({ destination }) }),
        onSuccess: () => {
            setAddPartyInput('');
            setAddPartyOpen(false);
            queryClient.invalidateQueries({ queryKey: ['active-call'] });
        },
        onError: (err: unknown) => showToast(err instanceof Error ? err.message : 'Failed to add party', 'error')
    });

    function submitAddParty() {
        // The button already disables on isPending, but Enter in the input
        // field calls this directly with no such guard — without this,
        // pressing Enter twice quickly fires two concurrent add-party
        // requests for the same call.
        if (addParty.isPending) return;
        const phone = formatPhone(addPartyInput);
        if (!isValidPhone(phone)) {
            showToast('Enter a valid Kenyan number', 'error');
            return;
        }
        addParty.mutate(`+${phone}`);
    }

    // SIP.js's own session is the source of truth for anything the browser
    // directly witnesses in real time (this screen's render condition, mute,
    // hold) — the 5s Supabase poll stays authoritative for things only the
    // server knows (wrap-up/ticket triggers), so the two don't fight over
    // the same state. Falling back to the polled call keeps the screen
    // visible during the brief gap right after answering, before the local
    // SIP.js session has finished transitioning to Established.
    const activeCaller = softphoneCall?.remoteNumber ?? polledCall?.caller;

    useEffect(() => {
        const startedAt = softphoneCall?.startedAt ?? (polledCall ? new Date(polledCall.created_at).getTime() : null);
        if (!startedAt) return;
        const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [softphoneCall?.startedAt, polledCall]);

    // Precedence matches the old banners' own rule (OutgoingCallBanner hid
    // itself if an incomingCall was somehow ringing at the same instant).
    const phase = incomingCall ? 'incoming' : outgoingCall ? 'outgoing' : activeCaller ? 'active' : null;

    // Only the 'incoming' phase gets a role="alert" live region below —
    // 'active' (connected) and the call ending had no screen-reader
    // announcement at all. This tracks phase transitions and drives a
    // separate, always-polite status region for those.
    const [announcement, setAnnouncement] = useState('');
    const [lingerAfterEnd, setLingerAfterEnd] = useState(false);
    const prevPhaseRef = useRef<typeof phase>(null);

    useEffect(() => {
        const prev = prevPhaseRef.current;
        prevPhaseRef.current = phase;
        if (prev === phase) return;

        if (phase === 'active') {
            setAnnouncement('Call connected');
        } else if (!phase && prev) {
            // The whole screen unmounts the instant phase goes null (see the
            // early return below) — without lingering a moment, the
            // aria-live region announcing "Call ended" would already be
            // gone before any screen reader could read it.
            setAnnouncement('Call ended');
            setLingerAfterEnd(true);
            const timer = setTimeout(() => setLingerAfterEnd(false), 1500);
            return () => clearTimeout(timer);
        }
    }, [phase]);

    // The ticket drawer can only be opened from the active-call controls, but
    // needs to survive the call ending — an agent still finishing a ticket
    // when the customer hangs up shouldn't have it snatched away just
    // because `phase` (and the call card above it) disappeared.
    if (!phase && !quickTicketOpen && !lingerAfterEnd) return null;

    const displayNumber = phase === 'incoming' ? incomingCall!.callerNumber : phase === 'outgoing' ? outgoingCall!.remoteNumber : activeCaller;
    const addPartyStatus = polledCall?.add_party_status;
    const addPartyBusy = addPartyStatus === 'requested' || addPartyStatus === 'dialing';

    return (
        <div className="call-screen-stack">
            <div aria-live="polite" role="status" className="sr-only">{announcement}</div>
            {phase && (
            <div
                className={`call-screen call-screen-${phase} ${phase === 'incoming' && !hasGestured ? 'call-screen-pulse' : ''}`}
                role={phase === 'incoming' ? 'alert' : undefined}
                aria-live={phase === 'incoming' ? 'assertive' : undefined}
            >
                <div className="call-screen-avatar-wrap">
                    {phase === 'incoming' && <span className="call-screen-ripple" />}
                    <div className="call-screen-avatar">
                        <Phone size={32} />
                    </div>
                </div>
                <div className="call-screen-number">{displayNumber}</div>
                <div className="call-screen-status">
                    {phase === 'incoming' && 'Incoming call…'}
                    {phase === 'outgoing' && 'Calling…'}
                    {phase === 'active' && <span className="call-screen-timer">{formatDuration(seconds)}</span>}
                </div>
                {phase === 'active' && addPartyStatus && (
                    <div className={`call-screen-add-party-status ${addPartyStatus === 'failed' ? 'call-screen-add-party-failed' : ''}`}>
                        {ADD_PARTY_LABELS[addPartyStatus]}
                    </div>
                )}

                {phase === 'incoming' && (
                    <div className="call-screen-primary-actions">
                        <button className="call-screen-round-btn call-screen-btn-reject" onClick={reject} aria-label="Reject">
                            <X size={26} />
                        </button>
                        <button className="call-screen-round-btn call-screen-btn-answer" onClick={answer} aria-label="Answer">
                            <Phone size={26} />
                        </button>
                    </div>
                )}

                {phase === 'outgoing' && (
                    <div className="call-screen-primary-actions">
                        <button className="call-screen-round-btn call-screen-btn-reject" onClick={cancelOutgoingCall} aria-label="Cancel">
                            <PhoneOff size={26} />
                        </button>
                    </div>
                )}

                {phase === 'active' && (
                    <>
                        <div className="call-screen-controls-grid">
                            {softphoneCall && (
                                <>
                                    <button
                                        className={`call-screen-control ${softphoneCall.muted ? 'call-screen-control-active' : ''}`}
                                        onClick={toggleMute}
                                    >
                                        {softphoneCall.muted ? <MicOff size={20} /> : <Mic size={20} />}
                                        <span>{softphoneCall.muted ? 'Unmute' : 'Mute'}</span>
                                    </button>
                                    <button
                                        className={`call-screen-control ${softphoneCall.held ? 'call-screen-control-active' : ''}`}
                                        onClick={toggleHold}
                                        title={softphoneCall.held ? 'They currently hear silence' : "They'll hear silence, not hold music"}
                                    >
                                        {softphoneCall.held ? <Play size={20} /> : <Pause size={20} />}
                                        <span>{softphoneCall.held ? 'Resume' : 'Hold'}</span>
                                    </button>
                                    <button
                                        className="call-screen-control"
                                        onClick={() => (addPartyOpen ? submitAddParty() : setAddPartyOpen(true))}
                                        disabled={addParty.isPending || addPartyBusy}
                                        title="Add a party to this call — merges straight in once they answer"
                                    >
                                        <UserPlus size={20} />
                                        <span>Add Call</span>
                                    </button>
                                    {audioOutputSupported && (
                                        <button
                                            className={`call-screen-control ${speakerOn ? 'call-screen-control-active' : ''}`}
                                            onClick={toggleSpeaker}
                                            title="Switch between the earpiece and speaker output"
                                        >
                                            {speakerOn ? <Speaker size={20} /> : <Volume2 size={20} />}
                                            <span>Speaker</span>
                                        </button>
                                    )}
                                </>
                            )}
                            <button className="call-screen-control" onClick={openQuickTicket}>
                                <TicketIcon size={20} />
                                <span>Add Ticket</span>
                            </button>
                        </div>
                        {softphoneCall && addPartyOpen && (
                            <input
                                autoFocus
                                value={addPartyInput}
                                onChange={e => setAddPartyInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') submitAddParty();
                                    if (e.key === 'Escape') setAddPartyOpen(false);
                                }}
                                placeholder="Number to add"
                                className="call-screen-add-party-input"
                            />
                        )}
                        {softphoneCall && (
                            <button className="call-screen-round-btn call-screen-btn-end" onClick={hangup} aria-label="End call">
                                <PhoneOff size={26} />
                            </button>
                        )}
                    </>
                )}
            </div>
            )}
            <TicketDrawer />
        </div>
    );
}
