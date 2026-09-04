import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, Delete, X } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { useSoftphone } from '../../lib/softphone';
import { formatPhone, isValidPhone } from '../../lib/phoneFormat';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

type RecentCall = { session_id: string; caller: string };

export default function FloatingDialer() {
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState('');
    const [error, setError] = useState('');
    const [calling, setCalling] = useState(false);
    const showToast = useToast();
    const { registrationState, activeCall, outgoingCall, incomingCall, placeCall } = useSoftphone();

    // Only fetched while the popover is actually open — no point polling
    // call history in the background for a widget nobody's looking at.
    const { data: recentData } = useQuery({
        queryKey: ['dialer-recent-calls'],
        queryFn: () => apiFetch('/api/calls?tab=all&pageSize=8'),
        enabled: open
    });

    // Deduped by number (most-recent first, since the API already orders
    // by created_at desc) — calling the same person twice in a row
    // shouldn't show them twice in a 5-item "recent" list.
    const recent: RecentCall[] = Array.from(
        new Map<string, RecentCall>((recentData?.calls ?? []).map((c: RecentCall) => [c.caller, c])).values()
    ).slice(0, 5);

    async function makeCall() {
        const phone = formatPhone(input);

        if (!isValidPhone(phone)) {
            setError('Enter a valid Kenyan number');
            return;
        }

        if (registrationState !== 'registered') {
            setError('Softphone is not registered yet — check your connection');
            return;
        }

        // Placing a second call while one is already active/ringing would
        // silently overwrite the tracked activeCall/outgoingCall state —
        // the first call would keep running server-side with no UI left to
        // control it.
        if (activeCall || outgoingCall || incomingCall) {
            setError('Finish or end the current call first');
            return;
        }

        setError('');
        setCalling(true);

        try {
            // formatPhone strips the leading "+" (254XXXXXXXXX); the
            // dialplan's outbound pattern expects the full E.164 form.
            // No toast here — the outgoing-call banner takes over as the
            // "calling…" feedback the moment placeCall's INVITE goes out.
            await placeCall(`+${phone}`);
            setInput('');
            setOpen(false);
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Call failed', 'error');
        } finally {
            setCalling(false);
        }
    }

    // The keypad has no way to type "+" at all — this inserts the one
    // country code this product actually dials today, rather than making
    // agents type "254" digit by digit or remember it's optional.
    function insertCountryCode() {
        setInput(i => (i.startsWith('+254') ? i : `+254${i.replace(/^0/, '')}`));
    }

    // Same Escape-only convention as TicketDrawer — this popover has no
    // backdrop and isn't a modal, so no Tab-trap, just a quick way out for a
    // keyboard user who opened it and changed their mind.
    useEffect(() => {
        if (!open) return;
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false);
        }
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open]);

    return (
        <div className="floating-dialer">
            {open && (
                <div className="dialer-popover dialer-popover-open">
                    <div className="dialer-popover-header">
                        <div className="dialer-popover-title">Dialer</div>
                        <button className="btn-icon" onClick={() => setOpen(false)} aria-label="Close dialer" type="button">
                            <X size={16} />
                        </button>
                    </div>
                    <div className="dialer-display-row">
                        <button className="dialer-country-code" onClick={insertCountryCode} title="Insert +254" type="button">
                            +254
                        </button>
                        <input
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && makeCall()}
                            placeholder="Enter number"
                            className="dialer-display"
                            autoFocus
                        />
                        {input && (
                            <button
                                className="dialer-backspace"
                                onClick={() => setInput(i => i.slice(0, -1))}
                                aria-label="Backspace"
                                type="button"
                            >
                                <Delete size={18} />
                            </button>
                        )}
                    </div>
                    <div className="dialer-keypad">
                        {KEYS.map(k => (
                            <button key={k} className="dialer-key" onClick={() => setInput(i => i + k)}>
                                {k}
                            </button>
                        ))}
                    </div>
                    {error && <p className="error">{error}</p>}
                    <div className="dialer-popover-actions">
                        <button className="dialer-call-btn" onClick={makeCall} disabled={calling} aria-label="Call">
                            <Phone size={22} />
                        </button>
                        {calling && <span className="hint">Calling…</span>}
                    </div>
                    {recent.length > 0 && (
                        <div className="dialer-recent">
                            <div className="dialer-recent-label">Recent</div>
                            {recent.map(c => (
                                <button key={c.session_id} className="dialer-recent-item" onClick={() => setInput(c.caller)}>
                                    {c.caller}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            <button
                className="fab fab-dialer"
                onClick={() => setOpen(o => !o)}
                title="Quick dial"
                aria-label="Quick dial"
                aria-expanded={open}
            >
                📞
            </button>
        </div>
    );
}
