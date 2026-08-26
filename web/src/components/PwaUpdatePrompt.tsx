import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

const UPDATE_CHECK_MS = 30 * 60 * 1000;

// vite-plugin-pwa's default behavior with no callbacks is an UNCONDITIONAL
// window.location.reload() the instant a new version activates — with no
// warning, and not gated by the isCallInProgress() check this codebase
// already built for exactly this class of problem (see callState.ts,
// used in api.ts to avoid yanking an agent to /login mid-call). A reload
// an agent didn't ask for can drop a live call or lose unrelated unsaved
// work (a ticket note, an IVR edit) — the standard, safe PWA pattern is to
// never reload silently and always let the person choose when.
//
// Registered here (inside the React tree, not main.tsx) so it can use the
// toast/context machinery — onNeedReload only sets state; the actual
// reload only ever happens from the button below.
export default function PwaUpdatePrompt() {
    const [updateReady, setUpdateReady] = useState(false);

    useEffect(() => {
        const updateSW = registerSW({
            immediate: true,
            onRegisteredSW(_url, registration) {
                // An already-open tab otherwise only re-checks for an
                // update on a fresh navigation — for a tool agents keep
                // open all day, that could mean hours before a deployed
                // fix is even noticed. This periodic check is the other
                // half of the fix, alongside never auto-reloading.
                if (!registration) return;
                const interval = setInterval(() => registration.update(), UPDATE_CHECK_MS);
                return () => clearInterval(interval);
            },
            onNeedReload() {
                setUpdateReady(true);
            }
        });
        return () => {
            // registerSW's return value is itself the update-trigger
            // function, not a cleanup handle — nothing to dispose here.
            void updateSW;
        };
    }, []);

    if (!updateReady) return null;

    return (
        <div className="pwa-update-banner" role="status">
            <span>A new version of Chumz is available.</span>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
                Refresh
            </button>
            <button className="btn-icon" onClick={() => setUpdateReady(false)} aria-label="Dismiss">
                ×
            </button>
        </div>
    );
}
