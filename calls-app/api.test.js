import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import apiRoutes from './api.js';

// api.js takes requireAuth/requireSupervisor as injected parameters rather
// than importing auth.js directly — real auth logic is unit-tested in
// auth.test.js; these stubs only need to prove that a route is actually
// wired to the right gate, not re-test what a gate itself does.
const allow = (req, res, next) => next();
const deny = (req, res) => res.status(401).json({ error: 'Not authenticated' });

function buildApp({ requireAuth = allow, requireSupervisor = allow, supabase }) {
    const app = express();
    app.use(express.json());
    apiRoutes(app, supabase, requireAuth, requireSupervisor);
    return app;
}

// Mocks exactly the chain GET /api/queue actually calls:
// .from('call_logs').select('*').in(...).order(...) -> { data, error }.
function mockSupabaseQueue({ data = [], error = null } = {}) {
    return {
        from: () => ({
            select: () => ({
                in: () => ({
                    order: () => Promise.resolve({ data, error })
                })
            })
        })
    };
}

describe('GET /api/queue', () => {
    it('never reaches the handler when requireAuth rejects the request', async () => {
        const app = buildApp({ requireAuth: deny, supabase: mockSupabaseQueue() });

        const res = await request(app).get('/api/queue');

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Not authenticated' });
    });

    it('separates callers still in the IVR menu from callers actually on hold', async () => {
        const now = Date.now();
        const supabase = mockSupabaseQueue({
            data: [
                { session_id: 'a', status: 'queued', created_at: new Date(now - 30_000).toISOString() },
                { session_id: 'b', status: 'ivr_started', created_at: new Date(now - 10_000).toISOString() }
            ]
        });
        const app = buildApp({ supabase });

        const res = await request(app).get('/api/queue');

        expect(res.status).toBe(200);
        expect(res.body.calls).toHaveLength(2);
        expect(res.body.calls.find(c => c.session_id === 'a').stage).toBe('Waiting');
        expect(res.body.calls.find(c => c.session_id === 'b').stage).toBe('In Menu');
        // Only the 'Waiting' row counts toward queue stats — a caller still
        // navigating the menu hasn't started waiting for an agent yet.
        expect(res.body.stats.inQueue).toBe(1);
    });

    it('returns 500 (not a crash) when the query itself fails', async () => {
        const supabase = mockSupabaseQueue({ error: { message: 'connection reset' } });
        const app = buildApp({ supabase });

        const res = await request(app).get('/api/queue');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to load queue' });
    });
});

describe('GET /api/agents', () => {
    it('is gated by requireSupervisor, not requireAuth', async () => {
        const supervisorDeny = (req, res) => res.status(403).json({ error: 'Supervisor access required' });
        const app = buildApp({ requireSupervisor: supervisorDeny, requireAuth: allow, supabase: {} });

        const res = await request(app).get('/api/agents');

        expect(res.status).toBe(403);
    });
});
