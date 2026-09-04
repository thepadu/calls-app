import { useEffect, useRef } from 'react';

// Shared modal accessibility: focus the first control on open, trap Tab
// inside the dialog, close on Escape. Used by ConfirmDialog and the
// add/edit modals in Agents/IvrEditor.
export function useModalA11y(open: boolean, onClose: () => void) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;

        // Whatever had focus before this modal opened (almost always the
        // button that triggered it) — restored on close below, so keyboard
        // users land back where they were instead of falling through to
        // <body> with no visible focus indicator anywhere.
        const previouslyFocused = document.activeElement as HTMLElement | null;

        const container = containerRef.current;
        const focusable = container?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        focusable?.[0]?.focus();

        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                onClose();
                return;
            }

            if (e.key !== 'Tab' || !focusable || focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            previouslyFocused?.focus();
        };
    }, [open, onClose]);

    return containerRef;
}
