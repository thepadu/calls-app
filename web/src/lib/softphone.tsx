import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { UserAgent, Registerer, RegistererState, Inviter, SessionState } from 'sip.js';
import type { Invitation, Session } from 'sip.js';
import { apiFetch } from './api';
import { useAuth } from './auth';
import { useToast } from './toast';
import { isCallInProgress, setCallInProgress } from './callState';

export type RegistrationState = 'unregistered' | 'registering' | 'registered' | 'failed';

type IncomingCall = { session: Invitation; callerNumber: string };
type OutgoingCall = { session: Inviter; remoteNumber: string };
type ActiveCall = { session: Session; remoteNumber: string; muted: boolean; held: boolean; startedAt: number };

type SoftphoneContextValue = {
    registrationState: RegistrationState;
    incomingCall: IncomingCall | null;
    outgoingCall: OutgoingCall | null;
    activeCall: ActiveCall | null;
    answer: () => Promise<void>;
    reject: () => void;
    hangup: () => void;
    cancelOutgoingCall: () => void;
    toggleMute: () => void;
    toggleHold: () => void;
    placeCall: (destinationE164: string) => Promise<void>;
    audioOutputSupported: boolean;
    speakerOn: boolean;
    toggleSpeaker: () => Promise<void>;
    micPermissionDenied: boolean;
};

const SoftphoneContext = createContext<SoftphoneContextValue>({
    registrationState: 'unregistered',
    incomingCall: null,
    outgoingCall: null,
    activeCall: null,
    answer: async () => {},
    reject: () => {},
    hangup: () => {},
    cancelOutgoingCall: () => {},
    toggleMute: () => {},
    toggleHold: () => {},
    placeCall: async () => {},
    audioOutputSupported: false,
    speakerOn: false,
    toggleSpeaker: async () => {},
    micPermissionDenied: false
});

// setSinkId() is a real method on HTMLMediaElement in Chrome/Edge but isn't
// in the standard lib.dom typings yet (Safari/Firefox don't implement it at
// all) — narrowed locally rather than widening the global HTMLAudioElement type.
type SinkableAudioElement = HTMLAudioElement & {
    setSinkId?: (sinkId: string) => Promise<void>;
};

// Explicit rather than a bare `audio: true` (which just takes whatever the
// browser's own default happens to be) — the agent heard an echo of their
// own voice during testing, most likely acoustic feedback from speakerphone
// use re-entering the mic. This doesn't fully solve that (no web API can,
// once a speaker's output is loud enough to re-enter the mic before the
// canceller can act — that needs the OS/hardware's own AEC), but it does
// guarantee the browser's best available cancellation is actually engaged
// rather than left to chance.
const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// Attaches whatever audio tracks the peer connection is receiving to a
// hidden <audio> element — SIP.js doesn't do this for you, it just hands you
// the underlying RTCPeerConnection.
function attachRemoteAudio(session: Session, audioEl: HTMLAudioElement) {
    const pc = (session.sessionDescriptionHandler as unknown as { peerConnection: RTCPeerConnection })
        ?.peerConnection;
    if (!pc) return;
    const remoteStream = new MediaStream();
    pc.getReceivers().forEach(receiver => {
        if (receiver.track) remoteStream.addTrack(receiver.track);
    });
    audioEl.srcObject = remoteStream;
    audioEl.play().catch(() => {});
}

function getAudioSender(session: Session) {
    const pc = (session.sessionDescriptionHandler as unknown as { peerConnection: RTCPeerConnection })
        ?.peerConnection;
    return pc?.getSenders().find(s => s.track?.kind === 'audio') ?? null;
}

// Backgrounding the tab/PWA (switching apps mid-call on mobile) commonly
// suspends getUserMedia capture at the OS/browser level while leaving the
// RTCPeerConnection itself connected — the call stays "connected" but the
// caller stops hearing the agent, with nothing here noticing or recovering
// on its own. This is recovery, not prevention: that suspension is a
// deliberate browser privacy/battery policy that can't be overridden, only
// detected and fixed once the page is foregrounded again. A plain
// replaceTrack() (not an ICE restart) is enough — swapping the local track
// doesn't need SDP renegotiation, so this can't interact with
// watchIceConnection's restart above.
function watchLocalTrackHealth(session: Session) {
    function isSuspended() {
        const sender = getAudioSender(session);
        return !!sender?.track && (sender.track.muted || sender.track.readyState === 'ended');
    }

    async function recover() {
        if (session.state !== SessionState.Established || !isSuspended()) return;
        const sender = getAudioSender(session);
        if (!sender) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO_CONSTRAINTS, video: false });
            const [freshTrack] = stream.getAudioTracks();
            if (freshTrack) await sender.replaceTrack(freshTrack);
        } catch (err) {
            console.error('[softphone] failed to recover local audio track after backgrounding:', err);
        }
    }

    const sender = getAudioSender(session);
    if (sender?.track) {
        sender.track.onmute = () => console.warn('[softphone] local audio track muted (likely backgrounded)');
        sender.track.onunmute = () => console.log('[softphone] local audio track unmuted');
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'visible') recover();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    session.stateChange.addListener(state => {
        if (state === SessionState.Terminated) document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
}

// The reconnect logic on the UserAgent's transport (see onDisconnect below)
// only recovers the ability to register/receive new calls — it does nothing
// for a call already in progress when an agent's network changes (wifi to
// mobile, a NAT rebind). That leaves the SIP signaling connection perfectly
// fine while the actual audio path is dead, with nothing to notice or fix
// it short of the call just going silent. A re-INVITE with iceRestart tells
// the browser to renegotiate a fresh ICE candidate pair on the existing
// dialog — the same call continues, just with a new media path.
// 'disconnected' is often transient (a missed STUN consent check, a brief
// packet loss) and self-recovers without help — only 'failed' is the
// browser's own final word. Debouncing 'disconnected' avoids firing a
// restart for something that would have cleared itself a moment later;
// 3s is comfortably shorter than most browsers' own internal
// disconnected-to-failed transition, so this is the one giving a
// deterministic response instead of waiting on that.
const ICE_DISCONNECTED_DEBOUNCE_MS = 3000;

function watchIceConnection(session: Session, onRestartFailed: () => void) {
    const pc = (session.sessionDescriptionHandler as unknown as { peerConnection: RTCPeerConnection })
        ?.peerConnection;
    if (!pc) return;
    const startedAt = Date.now();
    let restarting = false;
    let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;

    function attemptRestart(reason: string) {
        if (restarting || session.state !== SessionState.Established) return;
        restarting = true;
        // Logged with call duration so far — if an echo report recurs, this
        // lets its timing be correlated against real restart events instead
        // of guessing whether the two are actually related.
        console.warn(`[softphone] ICE ${reason} mid-call (${Math.round((Date.now() - startedAt) / 1000)}s in) — attempting ICE restart`);
        // offerOptions is a web-platform-specific SessionDescriptionHandlerOptions
        // field that Session.invite()'s core type (shared across non-browser
        // platforms) doesn't declare, even though it's exactly what the web
        // SDH this app actually uses reads at runtime to trigger a real
        // RTCPeerConnection ICE restart.
        const restartOptions = {
            sessionDescriptionHandlerOptions: { offerOptions: { iceRestart: true } }
        } as unknown as Parameters<typeof session.invite>[0];
        session
            .invite(restartOptions)
            .catch(err => {
                console.error('[softphone] ICE restart failed — call may drop:', err);
                onRestartFailed();
            })
            .finally(() => {
                restarting = false;
            });
    }

    pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
            clearTimeout(disconnectedTimer);
            disconnectedTimer = undefined;
            return;
        }
        if (state === 'failed') {
            clearTimeout(disconnectedTimer);
            disconnectedTimer = undefined;
            attemptRestart('connection failed');
            return;
        }
        if (state === 'disconnected' && !disconnectedTimer) {
            disconnectedTimer = setTimeout(() => {
                disconnectedTimer = undefined;
                if (pc.iceConnectionState === 'disconnected') attemptRestart('still disconnected');
            }, ICE_DISCONNECTED_DEBOUNCE_MS);
        }
    });
}

export function SoftphoneProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const showToast = useToast();
    const userAgentRef = useRef<UserAgent | null>(null);
    const registererRef = useRef<Registerer | null>(null);
    const domainRef = useRef<string>('sip.chumz.online');
    const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

    const [registrationState, setRegistrationState] = useState<RegistrationState>('unregistered');
    const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
    const [outgoingCall, setOutgoingCall] = useState<OutgoingCall | null>(null);
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
    const [speakerOn, setSpeakerOn] = useState(false);
    // Bumping this tears down and fully rebuilds the connection (fresh
    // credentials fetch, fresh UserAgent, fresh registration) via the main
    // connection effect's own cleanup/re-run cycle below — the most robust
    // way to recover from a tab that was backgrounded long enough for the
    // browser to throttle its timers into a zombie connection state, since
    // it doesn't assume the old transport is salvageable.
    const [reconnectNonce, setReconnectNonce] = useState(0);
    const reconnectDelayMsRef = useRef(1000);
    // A WebSocket blip mid-call used to tear the live call down along with
    // the transport — reconnectNonce's cleanup calls userAgent.stop(),
    // which (even with sip.js's default gracefulShutdown) synchronously
    // disposes the session's RTCPeerConnection, killing real, still-flowing
    // audio just because *signaling* dropped. Set true instead of bumping
    // reconnectNonce while a call is in progress; the effect below fires
    // the deferred reconnect once the call actually ends.
    const pendingReconnectRef = useRef(false);

    // Single source of truth for "is this agent mid-call right now" — kept
    // in sync here since incomingCall/outgoingCall/activeCall all live in
    // this hook, and consumed by api.ts (a plain function, not a hook) to
    // avoid force-redirecting an agent to /login mid-call over an unrelated
    // background 401. See callState.ts for the full reasoning.
    useEffect(() => {
        setCallInProgress(!!(incomingCall || outgoingCall || activeCall));
    }, [incomingCall, outgoingCall, activeCall]);
    const [micPermissionDenied, setMicPermissionDenied] = useState(false);
    const hasSetAvailableRef = useRef(false);
    const hasRequestedMicRef = useRef(false);

    const audioOutputSupported = typeof (window.HTMLMediaElement?.prototype as SinkableAudioElement)?.setSinkId === 'function';

    useEffect(() => {
        if (!remoteAudioRef.current) {
            const el = document.createElement('audio');
            el.autoplay = true;
            document.body.appendChild(el);
            remoteAudioRef.current = el;
        }
        return () => {
            remoteAudioRef.current?.remove();
            remoteAudioRef.current = null;
        };
    }, []);

    const handleSessionEstablished = useCallback(
        (session: Session, remoteNumber: string) => {
            if (remoteAudioRef.current) attachRemoteAudio(session, remoteAudioRef.current);
            watchIceConnection(session, () =>
                showToast('Call audio may have been lost — confirm with the customer or end and redial', 'error')
            );
            watchLocalTrackHealth(session);
            setActiveCall({ session, remoteNumber, muted: false, held: false, startedAt: Date.now() });
        },
        [showToast]
    );

    const handleSessionTerminated = useCallback(() => {
        // The <audio> element persists across calls (it's created once per
        // softphone session, not per call) — if a call ends while still on
        // hold, its .muted flag would otherwise stay true forever, leaving
        // the *next* call silent with no error or visual cue. Same reasoning
        // for the output sink: if a call ends while on speaker, the next
        // call would silently keep playing through it even though the UI
        // (reset below) shows the earpiece icon again.
        if (remoteAudioRef.current) {
            remoteAudioRef.current.muted = false;
            (remoteAudioRef.current as SinkableAudioElement).setSinkId?.('').catch(() => {});
        }
        setActiveCall(null);
        setSpeakerOn(false);
    }, []);

    const wireSessionStateChange = useCallback(
        (session: Session, remoteNumber: string) => {
            session.stateChange.addListener(state => {
                if (state === SessionState.Established) handleSessionEstablished(session, remoteNumber);
                else if (state === SessionState.Terminated) handleSessionTerminated();
            });
        },
        [handleSessionEstablished, handleSessionTerminated]
    );

    useEffect(() => {
        if (!user?.agentId) return;

        let cancelled = false;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

        (async () => {
            let creds;
            try {
                creds = await apiFetch('/api/agents/me/sip-credentials');
            } catch (err) {
                // A 404 here is expected for an agent with no softphone
                // credentials provisioned yet — anything else (401, 500,
                // network failure) is a real problem worth seeing rather
                // than silently leaving registrationState stuck at
                // 'unregistered' with no clue why. Either way this retries
                // with the same backoff as a dropped transport below, rather
                // than leaving the agent stuck on 'failed' until they
                // happen to switch tabs (which is the only other thing that
                // currently forces a retry) or refresh the page — a
                // supervisor provisioning credentials for a brand-new agent
                // takes effect automatically without either of those.
                console.error('[softphone] failed to fetch SIP credentials:', err);
                setRegistrationState('failed');
                const delay = reconnectDelayMsRef.current;
                reconnectDelayMsRef.current = Math.min(reconnectDelayMsRef.current * 2, 30000);
                reconnectTimer = setTimeout(() => {
                    if (!cancelled) setReconnectNonce(n => n + 1);
                }, delay);
                return;
            }
            if (cancelled) return;

            console.log(`[softphone] got credentials for ${creds.username}@${creds.domain}, connecting to ${creds.wssUrl}`);

            domainRef.current = creds.domain;
            const uri = UserAgent.makeURI(`sip:${creds.username}@${creds.domain}`);
            if (!uri) {
                console.error('[softphone] UserAgent.makeURI returned null for', creds.username, creds.domain);
                setRegistrationState('failed');
                return;
            }

            // Shared by the initial registration and every reconnect attempt
            // below, so a re-register after a dropped connection gets the
            // exact same failure handling as the first one — previously the
            // reconnect path fired-and-forgot register() with no onReject
            // and no catch, so a re-register that actually failed left the
            // agent silently unreachable with a stale "reconnected" toast as
            // the last thing they saw.
            const registerNow = async () => {
                if (!registererRef.current) return;
                try {
                    await registererRef.current.register({
                        requestDelegate: {
                            onReject: () => {
                                setRegistrationState('failed');
                                showToast('Softphone registration failed — you won’t receive browser calls', 'error');
                            }
                        }
                    });
                } catch (err) {
                    console.error('[softphone] registration threw:', err);
                    if (!cancelled) {
                        setRegistrationState('failed');
                        showToast('Softphone registration failed — you won’t receive browser calls', 'error');
                    }
                }
            };

            const userAgent = new UserAgent({
                uri,
                // keepAliveInterval pings the WebSocket every 30s so idle
                // periods (an agent's tab sitting untouched for hours)
                // don't get silently dropped by a proxy/NAT timing out an
                // apparently-inactive connection — this was the root cause
                // of "softphone not registered" after a while idle, with no
                // error and no automatic recovery. reconnectionAttempts is
                // 0 by default (no retry at all) — Infinity plus onConnect
                // re-registering below is what actually recovers a dropped
                // connection instead of leaving the agent silently
                // unreachable until they refresh the page.
                // SIP.js's own built-in reconnection is disabled
                // (reconnectionAttempts: 0) in favor of the fully-owned
                // backoff-driven reconnect in onDisconnect below — a single
                // clear recovery path instead of two independent retry
                // systems racing each other. A tab backgrounded long enough
                // for the browser to throttle its timers can leave the old
                // transport in a state SIP.js's own internal retry can't
                // necessarily recover from anyway; rebuilding the whole
                // UserAgent from scratch (fresh credentials, fresh
                // transport) via reconnectNonce is the more robust bet.
                transportOptions: { server: creds.wssUrl, keepAliveInterval: 30 },
                reconnectionAttempts: 0,
                authorizationUsername: creds.username,
                authorizationPassword: creds.password,
                // Without this, the browser's own ICE gathering had zero
                // NAT-traversal help — not even STUN — and relied entirely
                // on a direct host-candidate path succeeding. Any agent on
                // a symmetric NAT or a restrictive mobile/corporate network
                // would silently get one-way or no audio with nothing to
                // fall back to. The TURN server also answers plain STUN
                // binding requests, so one entry covers both.
                sessionDescriptionHandlerFactoryOptions: {
                    peerConnectionConfiguration: {
                        iceServers: [
                            { urls: creds.turnUrl.replace('turn:', 'stun:') },
                            { urls: creds.turnUrl, username: creds.turnUsername, credential: creds.turnPassword }
                        ]
                    }
                },
                delegate: {
                    onDisconnect: err => {
                        console.warn('[softphone] transport disconnected:', err?.message);
                        setRegistrationState('unregistered');

                        // Bumping reconnectNonce tears the whole effect down
                        // and rebuilds it (fresh UserAgent) via the cleanup
                        // below — including userAgent.stop(), which
                        // synchronously kills any live call's
                        // RTCPeerConnection even though the call's actual
                        // audio (SRTP) doesn't travel over this WebSocket at
                        // all and is very likely still fine. Deferred until
                        // the call ends (see the pendingReconnectRef effect
                        // below) rather than torn down immediately.
                        if (isCallInProgress()) {
                            if (!pendingReconnectRef.current) {
                                pendingReconnectRef.current = true;
                                showToast('Connection to server lost — call audio should be unaffected; reconnecting once this call ends', 'error');
                            }
                            return;
                        }

                        showToast('Softphone connection lost — reconnecting…', 'error');

                        // Exponential backoff (capped at 30s), reset to 1s on
                        // the next successful registration below — recovers
                        // a brief blip fast without hammering the server
                        // through a sustained outage.
                        const delay = reconnectDelayMsRef.current;
                        reconnectDelayMsRef.current = Math.min(reconnectDelayMsRef.current * 2, 30000);
                        reconnectTimer = setTimeout(() => {
                            if (!cancelled) setReconnectNonce(n => n + 1);
                        }, delay);
                    },
                    onInvite: (invitation: Invitation) => {
                        // The ARI-side queue shouldn't ring an agent who's
                        // already busy, but unlike placeCall (which refuses
                        // outright) nothing here guarded against it — a
                        // status-sync race on the server would silently swap
                        // the whole UI to a second incoming-call banner,
                        // stranding the agent with no controls left for the
                        // still-live first call. Declining immediately is a
                        // much safer failure mode than that.
                        if (isCallInProgress()) {
                            invitation.reject().catch(() => {});
                            return;
                        }
                        const callerNumber = invitation.remoteIdentity.uri.user ?? 'Unknown';
                        setIncomingCall({ session: invitation, callerNumber });
                        wireSessionStateChange(invitation, callerNumber);
                        invitation.stateChange.addListener(state => {
                            if (state === SessionState.Established || state === SessionState.Terminated) {
                                setIncomingCall(current => (current?.session === invitation ? null : current));
                            }
                        });
                    }
                }
            });

            userAgentRef.current = userAgent;
            setRegistrationState('registering');

            try {
                await userAgent.start();
                const registerer = new Registerer(userAgent);
                registererRef.current = registerer;
                registerer.stateChange.addListener(state => {
                    if (state === RegistererState.Registered) {
                        setRegistrationState('registered');
                        reconnectDelayMsRef.current = 1000;
                    } else if (state === RegistererState.Unregistered) {
                        setRegistrationState('unregistered');
                    }
                });
                await registerNow();
            } catch (err) {
                console.error('[softphone] registration threw:', err);
                if (!cancelled) {
                    setRegistrationState('failed');
                    showToast('Softphone registration failed — you won’t receive browser calls', 'error');
                }
            }
        })();

        return () => {
            cancelled = true;
            clearTimeout(reconnectTimer);
            pendingReconnectRef.current = false;
            registererRef.current?.unregister().catch(() => {});
            userAgentRef.current?.stop().catch(() => {});
            userAgentRef.current = null;
            registererRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.agentId, reconnectNonce]);

    // Fires the reconnect that onDisconnect/handleVisibilityChange deferred
    // while a call was in progress, the moment the call actually ends.
    useEffect(() => {
        const inCall = !!(incomingCall || outgoingCall || activeCall);
        if (!inCall && pendingReconnectRef.current) {
            pendingReconnectRef.current = false;
            reconnectDelayMsRef.current = 1000;
            setReconnectNonce(n => n + 1);
        }
    }, [incomingCall, outgoingCall, activeCall]);

    // A tab backgrounded long enough for the browser to throttle its timers
    // can leave the connection dead well before the backoff schedule above
    // would have noticed on its own — jumping straight to a fresh reconnect
    // the instant the agent actually looks at the screen again beats
    // waiting out whatever delay happened to be pending.
    useEffect(() => {
        function handleVisibilityChange() {
            if (document.visibilityState !== 'visible' || registrationState === 'registered') return;

            // Same reasoning as onDisconnect above — don't tear down a live
            // call's transport just to force a signaling reconnect. Deferred
            // via pendingReconnectRef, fired once the call ends.
            if (isCallInProgress()) {
                pendingReconnectRef.current = true;
                return;
            }

            console.log('[softphone] tab visible again while disconnected — forcing a fresh reconnect');
            reconnectDelayMsRef.current = 1000;
            setReconnectNonce(n => n + 1);
        }
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [registrationState]);

    // Tells the server "this browser is genuinely still connected" —
    // without it, agents.status='available' is just an unverified claim.
    // A dead tab, a lost connection, or a row seeded/provisioned as
    // available with nobody ever having logged in all look identical to
    // the rest of the app unless something actively confirms the opposite.
    // The ARI app flips anyone whose heartbeat goes stale back to offline
    // (see reconcileGhostAgents) — this is the signal that makes that safe.
    useEffect(() => {
        if (registrationState !== 'registered') return;

        const sendHeartbeat = () => {
            apiFetch('/api/agents/me/heartbeat', { method: 'PATCH' }).catch(() => {});
        };
        sendHeartbeat();
        const interval = setInterval(sendHeartbeat, 20000);
        return () => clearInterval(interval);
    }, [registrationState]);

    // Starts every session ready to take calls instead of requiring a manual
    // status flip first — but only once the softphone has actually
    // registered, not at raw login, since going 'available' before that
    // would let the queue ring an agent whose browser can't receive the
    // call yet. The ref guards against re-firing on every reconnect (a
    // dropped WebSocket auto-recovering shouldn't silently undo a deliberate
    // 'break').
    useEffect(() => {
        if (registrationState !== 'registered' || hasSetAvailableRef.current) return;
        hasSetAvailableRef.current = true;
        apiFetch('/api/agents/me/status', { method: 'PATCH', body: JSON.stringify({ status: 'available' }) }).catch(() => {});
    }, [registrationState]);

    // Microphone permission was previously only ever requested at the exact
    // moment of answering a real incoming call — the worst possible time to
    // discover it's blocked, with a customer already waiting. Requesting it
    // once here, right after registration, resolves the prompt (or reveals
    // an already-blocked state) during a calm moment instead. The stream
    // itself isn't needed — SIP.js acquires its own when a call is actually
    // answered — this call exists purely to trigger/check the permission.
    useEffect(() => {
        if (registrationState !== 'registered' || hasRequestedMicRef.current) return;
        hasRequestedMicRef.current = true;
        navigator.mediaDevices
            ?.getUserMedia({ audio: true })
            .then(stream => {
                stream.getTracks().forEach(track => track.stop());
                setMicPermissionDenied(false);
            })
            .catch(() => setMicPermissionDenied(true));
    }, [registrationState]);

    // Keeps the screen (and the tab driving the call) from being suspended
    // by the phone's own screen-timeout mid-call — exactly the kind of
    // background-throttling that was found dropping the SIP connection
    // during idle periods, now specifically guarded against for the one
    // window (an active call) where it matters most. Unsupported browsers
    // (older Safari/iOS versions) just don't get the protection — nothing
    // here depends on it existing.
    useEffect(() => {
        if (!activeCall || !('wakeLock' in navigator)) return;

        let sentinel: WakeLockSentinel | null = null;
        let cancelled = false;

        async function acquire() {
            try {
                sentinel = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.warn('[softphone] wake lock request failed:', err);
            }
        }
        acquire();

        // A wake lock is automatically released by the browser the instant
        // the tab is hidden and does NOT reacquire itself — a call that
        // survives a brief backgrounding (switching apps to check
        // something) would otherwise silently lose the protection for the
        // rest of its duration.
        function handleVisibilityChange() {
            if (document.visibilityState === 'visible' && !cancelled) acquire();
        }
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            sentinel?.release().catch(() => {});
        };
    }, [activeCall]);

    const answer = useCallback(async () => {
        if (!incomingCall) return;
        try {
            await incomingCall.session.accept({
                sessionDescriptionHandlerOptions: { constraints: { audio: CALL_AUDIO_CONSTRAINTS, video: false } }
            });
            // A successful accept() just proved the mic actually works —
            // clears a stale "blocked" banner left over from the proactive
            // post-registration check, which never re-checks on its own.
            setMicPermissionDenied(false);
        } catch {
            showToast('Could not answer — check microphone permissions', 'error');
            incomingCall.session.reject().catch(() => {});
            setIncomingCall(null);
        }
    }, [incomingCall, showToast]);

    // The UI always clears its own call state here regardless of whether the
    // underlying SIP request actually succeeds — leaving a banner/status bar
    // the agent can't dismiss would be worse than a rare stale server-side
    // leg. The toast on failure at least tells them it may not have ended
    // cleanly, instead of failing in total silence.
    const warnIfCallActionFails = useCallback(
        () => showToast('That may not have ended cleanly on the network — refresh if audio continues', 'error'),
        [showToast]
    );

    const reject = useCallback(() => {
        if (!incomingCall) return;
        const { session } = incomingCall;
        // A plain reject() only works pre-answer — if the session already
        // raced to Established (e.g. the ARI side answered it a moment
        // before the click registered), reject() is a no-op/throws and the
        // call would silently keep running with no banner left to end it.
        if (session.state === SessionState.Established) session.bye().catch(warnIfCallActionFails);
        else session.reject().catch(warnIfCallActionFails);
        setIncomingCall(null);
    }, [incomingCall, warnIfCallActionFails]);

    const hangup = useCallback(() => {
        if (!activeCall) return;
        const { session } = activeCall;
        if (session.state === SessionState.Established) session.bye().catch(warnIfCallActionFails);
        else (session as Invitation).reject?.().catch(warnIfCallActionFails);
        setActiveCall(null);
    }, [activeCall, warnIfCallActionFails]);

    const toggleMute = useCallback(() => {
        if (!activeCall) return;
        const sender = getAudioSender(activeCall.session);
        if (!sender?.track) {
            // A real race if clicked the instant a call connects, before the
            // peer connection has an audio sender yet — surface it rather
            // than silently doing nothing, so the agent knows to retry.
            showToast('Call audio isn’t ready yet — try again in a moment', 'error');
            return;
        }
        sender.track.enabled = activeCall.muted;
        setActiveCall({ ...activeCall, muted: !activeCall.muted });
    }, [activeCall, showToast]);

    // Local-only hold: mutes both directions (we stop sending, and the far
    // end's audio is not attached while held). The far end hears silence,
    // not hold music — real MOH-on-hold would need Asterisk-side dialplan
    // support, not built yet. Labelled honestly in the UI for this reason.
    const toggleHold = useCallback(() => {
        if (!activeCall || !remoteAudioRef.current) return;
        const sender = getAudioSender(activeCall.session);
        if (!sender?.track) {
            showToast('Call audio isn’t ready yet — try again in a moment', 'error');
            return;
        }
        const nextHeld = !activeCall.held;
        sender.track.enabled = !nextHeld && !activeCall.muted;
        remoteAudioRef.current.muted = nextHeld;
        setActiveCall({ ...activeCall, held: nextHeld });
    }, [activeCall, showToast]);

    // "Earpiece by default, speaker on request" is the real product intent,
    // but browsers don't expose a distinct earpiece device to switch to —
    // enumerateDevices() just lists whatever named outputs the OS reports,
    // and the default one is already earpiece-equivalent on mobile Chrome.
    // So this toggles between that default and the first non-default output
    // it can find (labelled "speaker" when one is), rather than pretending
    // to control physical hardware it has no API for.
    const toggleSpeaker = useCallback(async () => {
        const audioEl = remoteAudioRef.current as SinkableAudioElement | null;
        if (!audioEl?.setSinkId) return;

        try {
            if (speakerOn) {
                await audioEl.setSinkId('');
                setSpeakerOn(false);
                return;
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== '');
            const speaker = outputs.find(d => /speaker/i.test(d.label)) ?? outputs[0];

            if (!speaker) {
                showToast('No alternate output device found', 'error');
                return;
            }

            await audioEl.setSinkId(speaker.deviceId);
            setSpeakerOn(true);
        } catch {
            showToast('Failed to switch audio output', 'error');
        }
    }, [speakerOn, showToast]);

    const cancelOutgoingCall = useCallback(() => {
        if (!outgoingCall) return;
        const { session } = outgoingCall;
        // cancel() only works pre-answer. The ARI side answers our own leg
        // immediately (to give ringback while it dials out separately), so
        // by the time this fires the session may already be Established —
        // cancel() would silently fail there and leave the call running.
        if (session.state === SessionState.Established) session.bye().catch(warnIfCallActionFails);
        else session.cancel().catch(warnIfCallActionFails);
        setOutgoingCall(null);
    }, [outgoingCall, warnIfCallActionFails]);

    const placeCall = useCallback(
        async (destinationE164: string) => {
            const userAgent = userAgentRef.current;
            if (!userAgent || registrationState !== 'registered') {
                showToast('Softphone is not registered yet', 'error');
                return;
            }
            // A second concurrent call would silently overwrite
            // activeCall/outgoingCall's single-call state — the first call
            // would keep running server-side with no UI left to control it.
            if (activeCall || outgoingCall || incomingCall) {
                showToast('Finish or end the current call first', 'error');
                return;
            }
            const target = UserAgent.makeURI(`sip:${destinationE164}@${domainRef.current}`);
            if (!target) {
                // Every other failure path here shows a toast — this one
                // returned bare, so a malformed destination made the dialer
                // silently do nothing: no error, no call, no clue why. The
                // caller (FloatingDialer) treats a non-throwing placeCall()
                // as success and closes the popover as if the call went out.
                console.error('[softphone] UserAgent.makeURI returned null for', destinationE164, domainRef.current);
                showToast('Could not place call — invalid number', 'error');
                return;
            }

            const inviter = new Inviter(userAgent, target);
            setOutgoingCall({ session: inviter, remoteNumber: destinationE164 });
            wireSessionStateChange(inviter, destinationE164);
            inviter.stateChange.addListener(state => {
                if (state === SessionState.Established || state === SessionState.Terminated) {
                    setOutgoingCall(current => (current?.session === inviter ? null : current));
                }
            });

            try {
                await inviter.invite({ sessionDescriptionHandlerOptions: { constraints: { audio: CALL_AUDIO_CONSTRAINTS, video: false } } });
                // Same reasoning as answer() — a successful invite() proves the
                // mic works, so clear any stale "blocked" banner.
                setMicPermissionDenied(false);
            } catch {
                showToast('Call failed', 'error');
                setOutgoingCall(current => (current?.session === inviter ? null : current));
            }
        },
        [registrationState, activeCall, outgoingCall, incomingCall, showToast, wireSessionStateChange]
    );

    return (
        <SoftphoneContext.Provider
            value={{
                registrationState,
                incomingCall,
                outgoingCall,
                activeCall,
                answer,
                reject,
                hangup,
                cancelOutgoingCall,
                toggleMute,
                toggleHold,
                placeCall,
                audioOutputSupported,
                speakerOn,
                toggleSpeaker,
                micPermissionDenied
            }}
        >
            {children}
        </SoftphoneContext.Provider>
    );
}

export function useSoftphone() {
    return useContext(SoftphoneContext);
}
