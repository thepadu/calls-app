import { useEffect, useRef, useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { useSoftphone } from '../../lib/softphone';
import { useConnectivityCheck } from '../../lib/useConnectivityCheck';

type RowState = 'pending' | 'ok' | 'failed';

// softphone.tsx exposes micPermissionDenied (default false) but no separate
// "has the probe actually resolved yet" flag — getUserMedia's promise can
// take a moment (a real permission prompt if not yet granted). A short local
// grace window avoids flashing a false "OK" before that settles, without
// needing to add new state to softphone.tsx for it.
const MIC_CHECK_GRACE_MS = 1500;

function StatusIcon({ state }: { state: RowState }) {
    if (state === 'pending') return <Loader2 className="readiness-spin" size={16} />;
    if (state === 'ok') return <Check size={16} color="var(--brand)" />;
    return <X size={16} color="var(--danger)" />;
}

function Row({ label, state, detail }: { label: string; state: RowState; detail?: string }) {
    return (
        <div className={`readiness-row readiness-row-${state}`}>
            <span className="readiness-row-label">
                {label}
                {detail && <span className="readiness-row-detail"> — {detail}</span>}
            </span>
            <StatusIcon state={state} />
        </div>
    );
}

export default function ReadinessChecklist() {
    const { registrationState, micPermissionDenied } = useSoftphone();
    const connectivity = useConnectivityCheck();

    const shownRef = useRef(false);
    const [visible, setVisible] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [micGracePassed, setMicGracePassed] = useState(false);

    // Shown once per session, the first time registration reaches a
    // terminal-ish state — mirrors the ref-guard convention already used in
    // softphone.tsx (hasRequestedMicRef/hasSetAvailableRef) rather than
    // introducing sessionStorage, which nothing else in this app uses. A
    // full page reload naturally re-shows it, which is fine — it's a real
    // re-check of mic/network, not just a one-time tip.
    useEffect(() => {
        if (shownRef.current) return;
        if (registrationState !== 'registered' && registrationState !== 'failed') return;
        shownRef.current = true;
        setVisible(true);
        const timer = setTimeout(() => setMicGracePassed(true), MIC_CHECK_GRACE_MS);
        return () => clearTimeout(timer);
    }, [registrationState]);

    const micState: RowState = micPermissionDenied ? 'failed' : micGracePassed ? 'ok' : 'pending';
    const registrationRowState: RowState =
        registrationState === 'registered' ? 'ok' : registrationState === 'failed' ? 'failed' : 'pending';
    const connectivityState: RowState = connectivity === 'checking' ? 'pending' : connectivity === 'ok' ? 'ok' : 'failed';

    const allOk = micState === 'ok' && registrationRowState === 'ok' && connectivityState === 'ok';
    const anyFailed = micState === 'failed' || registrationRowState === 'failed' || connectivityState === 'failed';

    // Auto-dismiss once everything checks out — nothing left for the agent
    // to act on. Stays open (with a manual dismiss) if anything failed,
    // since that's exactly the situation this exists to surface.
    useEffect(() => {
        if (!allOk) return;
        const timer = setTimeout(() => setDismissed(true), 2000);
        return () => clearTimeout(timer);
    }, [allOk]);

    if (!visible || dismissed) return null;

    return (
        <div className="readiness-checklist" role="status">
            <div className="readiness-checklist-header">
                <span>Ready to take calls?</span>
                {(anyFailed || allOk) && (
                    <button className="readiness-dismiss" onClick={() => setDismissed(true)} aria-label="Dismiss">
                        <X size={14} />
                    </button>
                )}
            </div>
            <Row label="Microphone access" state={micState} detail={micState === 'failed' ? 'blocked — check your browser settings' : undefined} />
            <Row
                label="Softphone registration"
                state={registrationRowState}
                detail={registrationRowState === 'failed' ? 'could not register — try reloading' : undefined}
            />
            <Row
                label="Internet connection"
                state={connectivityState}
                detail={connectivityState === 'failed' ? 'unreachable' : undefined}
            />
        </div>
    );
}
