import { isCallInProgress } from './callState';

export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// The React app is served by the same Express process as the API (see
// app.js), so the session cookie set by /auth/google/callback rides along
// automatically — no token storage needed here.
export async function apiFetch(path: string, options: RequestInit = {}) {
    // A FormData body (file uploads) must NOT get an explicit Content-Type —
    // fetch/the browser generates one itself with the multipart boundary,
    // and setting 'application/json' here would break multer's parsing on
    // the server with no clear error.
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const res = await fetch(path, {
        credentials: 'include',
        headers: isFormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers },
        ...options
    });

    if (res.status === 401) {
        // A silent background call (the softphone heartbeat, an active-call
        // poll, any refetchInterval query) 401ing mid-call shouldn't yank
        // the whole page away to /login — indistinguishable from "connection
        // lost" to the agent, for a completely unrelated reason. Skipping
        // the redirect here is self-healing: the next call once the call
        // actually ends will 401 again and redirect normally then.
        if (!isCallInProgress()) window.location.href = '/login';
        throw new ApiError(401, 'Not authenticated');
    }

    if (!res.ok) {
        const body = await res.text();
        let message = body || 'Request failed';
        try {
            const parsed = JSON.parse(body);
            if (parsed?.error) message = parsed.error;
        } catch {
            // Not JSON (e.g. /call's plain-text error responses) — use the raw body.
        }
        throw new ApiError(res.status, message);
    }

    // /call (outbound.js) responds with plain text, not JSON — everything
    // under /api/* does return JSON, so branch on content-type rather than
    // assuming one or the other.
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('application/json') ? res.json() : res.text();
}
