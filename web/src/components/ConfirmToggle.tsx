import { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

type ConfirmToggleProps = {
    checked: boolean;
    ariaLabel: string;
    onChange: (next: boolean) => void;
    confirmTitle: string;
    confirmMessage: string;
    confirmLabel?: string;
};

// Every toggle in Settings that changes live call routing shares this exact
// shape: turning it ON needs a confirmation (it changes what happens to a
// real call starting immediately), turning it OFF doesn't. Previously
// hand-copied three times (Business Hours, Call Forwarding, Call Rating),
// each with its own comment cross-referencing the others — already drifted
// once (one used a two-element panel header, the others a single
// .panel.panel-header div) before this existed. See DECISIONS.md's UX-audit
// entry.
//
// Deliberately doesn't own the actual save/rollback logic — that stays with
// each caller's own mutation, since what "turning it off" does differs per
// panel (a form field flip here, a direct mutate there). This only owns the
// one thing that was actually identical everywhere: render the switch, and
// gate the ON direction behind a confirmation before calling onChange.
export default function ConfirmToggle({ checked, ariaLabel, onChange, confirmTitle, confirmMessage, confirmLabel = 'Turn on' }: ConfirmToggleProps) {
    const [confirming, setConfirming] = useState(false);

    function handleChange(next: boolean) {
        if (next) setConfirming(true);
        else onChange(false);
    }

    return (
        <>
            <label className="toggle-switch">
                <input type="checkbox" checked={checked} onChange={e => handleChange(e.target.checked)} aria-label={ariaLabel} />
                <span className="toggle-track"><span className="toggle-knob" /></span>
            </label>
            <ConfirmDialog
                open={confirming}
                title={confirmTitle}
                message={confirmMessage}
                confirmLabel={confirmLabel}
                onConfirm={() => {
                    onChange(true);
                    setConfirming(false);
                }}
                onCancel={() => setConfirming(false)}
            />
        </>
    );
}
