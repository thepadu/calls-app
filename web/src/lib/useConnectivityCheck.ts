import { useEffect, useState } from 'react';

export type ConnectivityState = 'checking' | 'ok' | 'failed';

// One-shot on mount, not polled — this isn't a "watch it forever" signal
// like the heartbeat or activeCall poll, just a single readiness check for
// the login checklist. navigator.onLine only proves the OS thinks it has a
// network interface (still 'true' on a captive portal or a genuinely dead
// upstream link); the /healthz round-trip is what actually confirms this
// browser can reach the dashboard's own server right now.
export function useConnectivityCheck(): ConnectivityState {
    const [state, setState] = useState<ConnectivityState>('checking');

    useEffect(() => {
        if (!navigator.onLine) {
            setState('failed');
            return;
        }

        let cancelled = false;
        fetch('/healthz', { credentials: 'include' })
            .then(res => {
                if (!cancelled) setState(res.ok ? 'ok' : 'failed');
            })
            .catch(() => {
                if (!cancelled) setState('failed');
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return state;
}
