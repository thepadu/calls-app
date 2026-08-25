const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

// 24h instead of a flat 7 days — shrinks the blast radius of a leaked
// cookie considerably. Sliding rather than fixed so a genuinely active
// agent's session never actually expires mid-shift: requireAuth below
// re-issues a fresh 24h token once an hour of real activity has passed,
// so only a session with nobody actively using it for a full day actually
// dies on schedule.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_REFRESH_AFTER_MS = 60 * 60 * 1000;

module.exports = function (app, supabase) {

    const client = new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_CALLBACK_URL?.trim()
    );

    // Shared by the initial login and every sliding-session refresh in
    // requireAuth below, so the token shape and cookie settings can't drift
    // out of sync between the two.
    function issueSession(res, { email, name, role, agentId }) {
        const sessionToken = jwt.sign({ email, name, role, agentId }, process.env.JWT_SECRET, {
            expiresIn: Math.floor(SESSION_TTL_MS / 1000)
        });
        res.cookie('session', sessionToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: SESSION_TTL_MS
        });
    }

    // Login is open to ANY Google account — no domain or allowlist check.
    // This was a deliberate choice (confirmed 2026-08-05), not an oversight:
    // anyone who reaches /login and signs in with Google gets a session.
    // What they can DO once signed in is governed by role (below) — an
    // unrecognized email defaults to 'agent', the more restricted role.

    // Without these, generateAuthUrl() silently builds a URL with no
    // redirect_uri param, which Google rejects with a cryptic
    // "Missing required parameter: redirect_uri" error on its own consent
    // screen — nothing in this app's own logs. Fail loudly here instead.
    const missingEnvVars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'JWT_SECRET']
        .filter(key => !process.env[key]);

    if (missingEnvVars.length) {
        // Fatal, not just logged: without these every login attempt dead-ends
        // in a generic "Authentication failed" and every request looks like
        // an expired session to requireAuth below — a silent full-app outage
        // with only one easily-missed console line as a clue. Loud and
        // immediate is far easier to diagnose than that, especially right
        // after a deploy/migration where a missing env var is the most
        // likely cause of anything going wrong at all.
        console.error(`❌ Google SSO is misconfigured — missing env var(s): ${missingEnvVars.join(', ')}`);
        process.exit(1);
    }

    // Bootstraps the very first supervisor(s) — there's otherwise no way for
    // anyone to become one (the roster's promote-to-supervisor control is
    // itself supervisor-gated). Comma-separated, case-insensitive.
    const supervisorEmails = (process.env.SUPERVISOR_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

    const LOGIN_ERROR_MESSAGES = {
        access_denied: 'Sign-in was cancelled. Click below to try again.',
        session_expired: 'That login attempt timed out or couldn’t be verified — please try again.',
        email_unverified: 'That Google account’s email isn’t verified. Please use a verified account.',
        auth_failed: 'Something went wrong signing you in. Please try again.'
    };

    app.get('/login', (req, res) => {
        const errorMessage = LOGIN_ERROR_MESSAGES[req.query.error];
        res.send(`
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
            <style>
                * { box-sizing: border-box; }
                body {
                    margin: 0;
                    font-family: 'Public Sans', -apple-system, BlinkMacSystemFont, sans-serif;
                    color: #0f172a;
                }
                .split {
                    display: flex;
                    min-height: 100vh;
                }
                .hero {
                    flex: 1 1 42%;
                    background: #14532d;
                    color: #ecfdf5;
                    padding: 64px;
                    display: flex;
                    flex-direction: column;
                    justify-content: space-between;
                    min-width: 320px;
                }
                .hero-logo {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .hero-logo-mark {
                    width: 34px;
                    height: 34px;
                    border-radius: 9px;
                    background: #4ade80;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-family: 'Sora', sans-serif;
                    font-weight: 800;
                    color: #14532d;
                }
                .hero-logo-text {
                    font-family: 'Sora', sans-serif;
                    font-weight: 700;
                    font-size: 20px;
                    letter-spacing: 0.02em;
                }
                .hero-headline {
                    font-family: 'Sora', sans-serif;
                    font-weight: 800;
                    font-size: 34px;
                    line-height: 1.25;
                    max-width: 420px;
                }
                .hero-sub {
                    margin-top: 18px;
                    font-size: 15px;
                    color: #a7f3d0;
                    max-width: 400px;
                    line-height: 1.6;
                }
                .hero-bullets {
                    display: flex;
                    flex-direction: column;
                    gap: 14px;
                    margin-top: 32px;
                }
                .hero-bullet {
                    display: flex;
                    gap: 12px;
                    align-items: center;
                    font-size: 14px;
                    color: #d1fae5;
                }
                .hero-bullet-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #4ade80;
                    flex-shrink: 0;
                }
                .hero-footer {
                    font-size: 12px;
                    color: #86efac;
                }
                .form-side {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                    background: #ffffff;
                }
                .form-card {
                    width: 100%;
                    max-width: 360px;
                    text-align: center;
                }
                .form-title {
                    font-family: 'Sora', sans-serif;
                    font-weight: 800;
                    font-size: 26px;
                    margin: 0 0 6px;
                }
                .form-sub {
                    color: #64748b;
                    font-size: 14px;
                    margin: 0 0 28px;
                }
                .form-error {
                    background: #fef2f2;
                    color: #b91c1c;
                    border: 1px solid #fecaca;
                    border-radius: 8px;
                    padding: 10px 14px;
                    font-size: 13px;
                    margin: 0 0 20px;
                    text-align: left;
                }
                .form-note {
                    color: #94a3b8;
                    font-size: 12px;
                    margin: 16px 0 0;
                    line-height: 1.5;
                }
                a.btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 10px;
                    width: 100%;
                    background: #15803d;
                    color: white;
                    padding: 12px 22px;
                    border-radius: 8px;
                    text-decoration: none;
                    font-weight: 700;
                    font-size: 15px;
                }
                @media (max-width: 720px) {
                    .hero { display: none; }
                }
            </style>
        </head>
        <body>
            <div class="split">
                <div class="hero">
                    <div class="hero-logo">
                        <div class="hero-logo-mark">C</div>
                        <div class="hero-logo-text">Chumz</div>
                    </div>
                    <div>
                        <div class="hero-headline">Every call is someone trusting us with their savings.</div>
                        <div class="hero-sub">
                            This console is how we show up for them — queue, tickets, IVR routing, and
                            forwarding, all in one place, so no caller waits and no issue gets missed.
                        </div>
                        <div class="hero-bullets">
                            <div class="hero-bullet"><div class="hero-bullet-dot"></div>Real-time queue &amp; agent visibility</div>
                            <div class="hero-bullet"><div class="hero-bullet-dot"></div>Update IVR routing without filing an engineering ticket</div>
                            <div class="hero-bullet"><div class="hero-bullet-dot"></div>Tag and ticket calls without leaving the queue</div>
                        </div>
                    </div>
                    <div class="hero-footer">© ${new Date().getFullYear()} Chumz. Internal tool — not for external distribution.</div>
                </div>
                <div class="form-side">
                    <div class="form-card">
                        <div class="form-title">Welcome back</div>
                        <p class="form-sub">Sign in with your Google account to start your shift.</p>
                        ${errorMessage ? `<div class="form-error">${errorMessage}</div>` : ''}
                        <a href="/auth/google" class="btn">
                            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/><path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.11-7.45 2.11-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.69 28.19A13.9 13.9 0 0 1 10.94 24c0-1.45.25-2.86.7-4.19v-5.7H4.34A22.9 22.9 0 0 0 2 24c0 3.72.89 7.23 2.34 10.19l7.35-5.7z"/><path fill="#EA4335" d="M24 10.75c3.23 0 6.14 1.11 8.42 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 13.81l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/></svg>
                            Sign in with Google
                        </a>
                        <p class="form-note">Installed Chumz to your home screen? Re-open it from there after signing in.</p>
                    </div>
                </div>
            </div>
        </body>
        </html>
        `);
    });

    app.get('/auth/google', (req, res) => {
        if (missingEnvVars.length) {
            return res.status(500).send(
                `Google SSO is misconfigured on the server — missing: ${missingEnvVars.join(', ')}. ` +
                `Set these in the DigitalOcean App Platform environment settings and redeploy.`
            );
        }

        // CSRF protection for the OAuth flow — without a state param tied
        // to this specific browser, nothing stops a callback request from
        // being replayed/forged against a different session. Short-lived
        // (10 min, comfortably longer than anyone takes to click through
        // Google's consent screen) and cleared on the callback either way.
        const state = crypto.randomBytes(16).toString('hex');
        res.cookie('oauth_state', state, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000
        });

        const url = client.generateAuthUrl({
            scope: ['profile', 'email'],
            prompt: 'select_account',
            state
        });
        res.redirect(url);
    });

    app.get('/auth/google/callback', async (req, res) => {
        const expectedState = req.cookies.oauth_state;
        res.clearCookie('oauth_state');

        if (!req.query.state || !expectedState || req.query.state !== expectedState) {
            return res.redirect('/login?error=session_expired');
        }

        // Google redirects back with `error` (not `code`) instead of failing
        // silently when the user cancels/denies on its own consent screen —
        // previously unhandled here, so this fell through to client.getToken
        // with an undefined code, throwing into the generic catch below and
        // showing a bare "Authentication failed" page with no way back.
        if (req.query.error) {
            return res.redirect('/login?error=access_denied');
        }

        try {
            const { tokens } = await client.getToken(req.query.code);
            const ticket = await client.verifyIdToken({
                idToken: tokens.id_token,
                audience: process.env.GOOGLE_CLIENT_ID
            });

            const payload = ticket.getPayload();

            if (!payload.email_verified) {
                return res.redirect('/login?error=email_unverified');
            }

            // Lowercased once, used everywhere below — agents.email has a
            // case-sensitive unique constraint, and Google's own payload.email
            // casing isn't guaranteed stable. Without this, a login whose
            // casing didn't byte-for-byte match however an agent's row was
            // originally provisioned (typed by hand during onboarding, for
            // instance) found no match here, fell into the "unrecognized
            // login" branch below, and silently created a brand-new
            // duplicate row — offline, no phone, no SIP credentials — while
            // the real row (with working SIP creds) sat untouched. The
            // agent's dashboard session then pointed at the empty duplicate
            // for its entire lifetime, showing "offline" no matter what
            // their actual, working softphone was doing.
            const loginEmail = payload.email.toLowerCase();

            // Look up whether this email is a recognized agent, and if so
            // what role/id they hold. Unrecognized emails default to 'agent'
            // (the more restricted role) rather than failing login — login
            // itself stays open to anyone, per the policy above. `agentId`
            // (when present) is how the frontend matches "my performance"
            // out of the agent-stats list without a separate lookup.
            let { data: agent } = await supabase
                .from('agents')
                .select('id, role')
                .ilike('email', loginEmail)
                .maybeSingle();

            // First time this email has ever logged in — create their roster
            // row now, so a supervisor actually has someone to see/promote.
            // Without this, an unrecognized login worked (role defaulted to
            // 'agent' in the JWT below) but left no trace anywhere a
            // supervisor could act on. `phone` stays null until a supervisor
            // sets one — they can't go "available" until then, but the row
            // itself needs to exist regardless.
            if (!agent) {
                const role = supervisorEmails.includes(loginEmail) ? 'supervisor' : 'agent';

                const { data: created, error: createError } = await supabase
                    .from('agents')
                    .upsert(
                        { email: loginEmail, name: payload.name, status: 'offline', role },
                        { onConflict: 'email' }
                    )
                    .select('id, role')
                    .single();

                if (createError) {
                    console.error('❌ Failed to provision agent row for new login:', createError.message);
                } else {
                    agent = created;
                }
            }

            const role = agent?.role === 'supervisor' ? 'supervisor' : 'agent';

            issueSession(res, { email: loginEmail, name: payload.name, role, agentId: agent?.id ?? null });

            res.redirect('/app');
        } catch (error) {
            console.error('❌ Google auth failed:', error.message);
            res.redirect('/login?error=auth_failed');
        }
    });

    app.get('/logout', (req, res) => {
        res.clearCookie('session');
        res.redirect('/login');
    });

    // Protects the JSON API (api.js) and the /export and /ticket routes —
    // API requests get a 401 JSON body instead of a redirect, since a
    // fetch() call has no browser chrome to redirect.
    async function requireAuth(req, res, next) {
        try {
            const payload = jwt.verify(req.cookies.session, process.env.JWT_SECRET, { algorithms: ['HS256'] });
            req.user = payload;

            // Sliding session: a genuinely active agent re-issues a fresh
            // 24h token roughly once an hour, so a long shift never
            // actually hits the expiry wall — only a session nobody's
            // touched for a full day does. `iat` is in seconds, everything
            // else here is milliseconds.
            if (Date.now() - payload.iat * 1000 > SESSION_REFRESH_AFTER_MS) {
                // Re-checked against the roster on every refresh, not just
                // copied from the old payload — otherwise a supervisor
                // demoted via the roster UI would keep re-authorizing as
                // supervisor for up to another 24h of activity, since
                // nothing else ever re-reads their role after login.
                const { data: agent } = await supabase
                    .from('agents')
                    .select('id, role')
                    .ilike('email', payload.email)
                    .maybeSingle();
                const role = agent?.role === 'supervisor' ? 'supervisor' : 'agent';
                const agentId = agent?.id ?? null;
                issueSession(res, { email: payload.email, name: payload.name, role, agentId });
                req.user = { ...payload, role, agentId };
            }

            next();
        } catch {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            res.redirect('/login');
        }
    }

    // Stricter than requireAuth — role is baked into the JWT at login time,
    // so promoting someone to supervisor requires them to log out/in (or
    // wait out the sliding-session refresh in requireAuth, up to ~1h of
    // activity) before it takes effect.
    function requireSupervisor(req, res, next) {
        requireAuth(req, res, () => {
            if (req.user?.role !== 'supervisor') {
                if (req.path.startsWith('/api/')) {
                    return res.status(403).json({ error: 'Supervisor access required' });
                }
                return res.status(403).send('Supervisor access required');
            }
            next();
        });
    }

    return { requireAuth, requireSupervisor };
};
