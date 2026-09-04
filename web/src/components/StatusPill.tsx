// Moneto brand palette: teal for "good/active" states, a lighter tealGreen
// for "in progress right now", gold-orange for "needs attention soon", and
// coral for anything that didn't go as planned. `ringing`, `break`, and
// `forwarded` used to all share the same gold-orange despite being three
// unrelated concepts (an urgent transient state, a calm intentional pause,
// and a missed-call outcome) — differentiated below, since color is one of
// the fastest things to scan across a table full of these pills even
// though text is always shown alongside it too.
export const STATUS_COLORS: Record<string, string> = {
    available: 'var(--brand)',
    on_call: 'var(--brand-bright)',
    ringing: 'var(--warning)',
    break: 'var(--status-break)',
    offline: 'var(--status-neutral)',
    completed: 'var(--brand)',
    ongoing: 'var(--brand-bright)',
    queued: 'var(--brand-bright)',
    dialing: 'var(--brand-bright)',
    failed: 'var(--danger)',
    forwarded: 'var(--status-forwarded)',
    after_hours: 'var(--status-neutral)'
};

export default function StatusPill({ value, label }: { value: string; label?: string }) {
    const color = STATUS_COLORS[value] || 'var(--status-neutral)';
    return (
        <span className="status-pill" style={{ background: color }}>
            {label ?? value.replace('_', ' ')}
        </span>
    );
}
