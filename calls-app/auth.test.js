import { beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import authRoutes from './auth.js';

// authRoutes registers routes on `app` as a side effect of being called —
// only app.get is used (confirmed via grep), so a no-op stub is enough to
// get at the requireAuth/requireSupervisor closures it returns.
const noopApp = { get: () => {} };

// Builds a Supabase mock whose `agents` table returns exactly one row (or
// none) for the `.select().ilike().maybeSingle()` chain requireAuth's
// sliding-session refresh uses to re-check an agent's current role.
function mockSupabase(agentRow) {
    return {
        from: () => ({
            select: () => ({
                ilike: () => ({
                    maybeSingle: () => Promise.resolve({ data: agentRow, error: null })
                })
            })
        })
    };
}

function mockReqRes(cookieToken, path = '/api/agents') {
    const req = { cookies: { session: cookieToken }, path };
    const res = {
        statusCode: null,
        body: null,
        redirected: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        redirect(url) {
            this.redirected = url;
        },
        cookie: () => {}
    };
    return { req, res };
}

// Backdating `iat` directly (rather than actually waiting in the test) is
// what exercises requireAuth's sliding-session refresh branch — it only
// fires once a session has gone quiet for over an hour of real time.
function signSession(payload, { issuedSecondsAgo = 0 } = {}) {
    return jwt.sign(
        { ...payload, iat: Math.floor(Date.now() / 1000) - issuedSecondsAgo },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );
}

beforeAll(() => {
    // auth.js validates these at call time and process.exit(1)s if any are
    // missing (see its own comment: better a loud startup failure than a
    // silent "every login dead-ends" outage) — the test needs all four set,
    // not just JWT_SECRET, or every authRoutes(...) call below exits Vitest.
    process.env.JWT_SECRET = 'test-secret-not-used-in-production';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_CALLBACK_URL = 'http://localhost/auth/google/callback';
});

describe('requireAuth', () => {
    it('accepts a valid, fresh session and calls next()', async () => {
        const { requireAuth } = authRoutes(noopApp, mockSupabase(null));
        const token = signSession({ email: 'agent@chumz.online', name: 'Agent', role: 'agent', agentId: 1 });
        const { req, res } = mockReqRes(token);
        let nextCalled = false;

        await requireAuth(req, res, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(req.user.email).toBe('agent@chumz.online');
        expect(res.statusCode).toBeNull();
    });

    it('returns 401 JSON (not a redirect) for an /api/ route with no session cookie', async () => {
        const { requireAuth } = authRoutes(noopApp, mockSupabase(null));
        const { req, res } = mockReqRes(undefined, '/api/agents');

        await requireAuth(req, res, () => {});

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: 'Not authenticated' });
        expect(res.redirected).toBeNull();
    });

    it('redirects to /login (not a 401) for a non-API route with an invalid session', async () => {
        const { requireAuth } = authRoutes(noopApp, mockSupabase(null));
        const { req, res } = mockReqRes('not-a-real-jwt', '/dashboard');

        await requireAuth(req, res, () => {});

        expect(res.redirected).toBe('/login');
        expect(res.statusCode).toBeNull();
    });

    it('re-checks the roster and demotes a stale session once it has gone quiet for over an hour', async () => {
        // Token still claims 'supervisor', but the roster (mocked below)
        // now says 'agent' — proves a demotion via the roster UI actually
        // takes effect on refresh instead of trusting the old JWT payload.
        const supabase = mockSupabase({ id: 5, role: 'agent' });
        const { requireAuth } = authRoutes(noopApp, supabase);
        const token = signSession(
            { email: 'agent@chumz.online', name: 'Agent', role: 'supervisor', agentId: 5 },
            { issuedSecondsAgo: 61 * 60 }
        );
        const { req, res } = mockReqRes(token);

        await requireAuth(req, res, () => {});

        expect(req.user.role).toBe('agent');
    });

    it('does not hit the roster at all for a session refreshed within the last hour', async () => {
        const supabase = mockSupabase({ id: 5, role: 'supervisor' });
        const fromSpy = vi.spyOn(supabase, 'from');
        const { requireAuth } = authRoutes(noopApp, supabase);
        const token = signSession({ email: 'agent@chumz.online', name: 'Agent', role: 'agent', agentId: 5 });
        const { req, res } = mockReqRes(token);

        await requireAuth(req, res, () => {});

        expect(fromSpy).not.toHaveBeenCalled();
    });
});

describe('requireSupervisor', () => {
    it('allows a supervisor through', async () => {
        const { requireSupervisor } = authRoutes(noopApp, mockSupabase(null));
        const token = signSession({ email: 's@chumz.online', name: 'Supervisor', role: 'supervisor', agentId: 2 });
        const { req, res } = mockReqRes(token);
        let nextCalled = false;

        await requireSupervisor(req, res, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
    });

    it('returns 403 JSON for a plain agent hitting an /api/ route', async () => {
        const { requireSupervisor } = authRoutes(noopApp, mockSupabase(null));
        const token = signSession({ email: 'a@chumz.online', name: 'Agent', role: 'agent', agentId: 3 });
        const { req, res } = mockReqRes(token, '/api/agents/1');

        await requireSupervisor(req, res, () => {});

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Supervisor access required' });
    });

    it('returns a plain-text 403 (not JSON) for a plain agent on a non-API route', async () => {
        const { requireSupervisor } = authRoutes(noopApp, mockSupabase(null));
        const token = signSession({ email: 'a@chumz.online', name: 'Agent', role: 'agent', agentId: 3 });
        const { req, res } = mockReqRes(token, '/export');

        await requireSupervisor(req, res, () => {});

        expect(res.statusCode).toBe(403);
        expect(res.body).toBe('Supervisor access required');
    });
});
