import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { X } from 'lucide-react';

type Toast = { id: number; message: string; kind: 'success' | 'error' };

const ToastContext = createContext<{ show: (message: string, kind?: Toast['kind']) => void }>({
    show: () => {}
});

let nextId = 1;

// Errors get longer on screen than a routine success confirmation — an
// agent who looks away for a moment mid-call (which is often) has more
// chance of actually seeing "softphone registration failed" before it
// auto-dismisses. Both are also manually dismissible now, and closing one
// doesn't need to wait out the timer at all.
const AUTO_DISMISS_MS: Record<Toast['kind'], number> = { success: 3500, error: 6000 };

// A burst of repeated failures (e.g. several background reconciliation
// errors in a row) shouldn't stack unboundedly and cover a large chunk of a
// narrow viewport for several seconds.
const MAX_VISIBLE_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: number) => {
        setToasts(current => current.filter(t => t.id !== id));
    }, []);

    const show = useCallback((message: string, kind: Toast['kind'] = 'success') => {
        const id = nextId++;
        setToasts(current => {
            // An identical message already on screen (e.g. the same error
            // firing repeatedly) gets refreshed in place rather than piling
            // up as a duplicate entry.
            const deduped = current.filter(t => !(t.message === message && t.kind === kind));
            const next = [...deduped, { id, message, kind }];
            return next.length > MAX_VISIBLE_TOASTS ? next.slice(next.length - MAX_VISIBLE_TOASTS) : next;
        });
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind]);
    }, [dismiss]);

    return (
        <ToastContext.Provider value={{ show }}>
            {children}
            <div className="toast-stack" role="status" aria-live="polite">
                {toasts.map(t => (
                    <div key={t.id} className={`toast toast-${t.kind}`}>
                        <span className="toast-message">{t.message}</span>
                        <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    return useContext(ToastContext).show;
}
