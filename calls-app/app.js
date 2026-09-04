const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const authRoutes = require('./auth');
const apiRoutes = require('./api');

// Express 4 does not route a rejected promise from an async route handler
// to any error middleware — it just becomes an "unhandled rejection" at the
// Node process level, which (Node 15+) terminates the process by default.
// Almost none of the routes below wrap their async body in try/catch (they
// mostly rely on Supabase returning `{error}` rather than throwing), so
// without this, a single unexpected error from any request — a library
// behaving differently than expected, a malformed payload reaching code
// that doesn't guard for it — would crash the server for every connected
// user, not just the one request. Logging and continuing turns that into a
// contained per-request failure instead. Registered before anything else
// so it's active for the entire process lifetime, including module init.
process.on('unhandledRejection', reason => {
    console.error('❌ Unhandled promise rejection:', reason);
});

// A genuinely uncaught synchronous exception means some code ran in a state
// nothing anticipated — safer to log it and let the process exit (DigitalOcean
// App Platform restarts the container automatically) than to keep serving requests from
// a process whose state integrity is no longer guaranteed.
process.on('uncaughtException', err => {
    console.error('❌ Uncaught exception, exiting:', err);
    process.exit(1);
});

const app = express();

// This app sits behind exactly one reverse proxy — DigitalOcean App
// Platform's own edge — which adds an X-Forwarded-For header to every
// request. Without this, express-rate-limit (below) sees that header and,
// unable to tell how many proxy hops are legitimate, logs a validation
// error on every rate-limited request rather than silently trusting a
// header a client could otherwise spoof to dodge rate limiting entirely.
// `1` means "trust exactly one hop" — matches DO App Platform's setup.
app.set('trust proxy', 1);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// A dashboard user's browser never gets close to these limits — GlobalPolling's
// busiest interval is 12 requests/minute, so 200/min per IP is only ever a
// backstop against scraping/brute-force, not something a real shift trips.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
// AT's own retry behavior during an upstream incident must never be the
// thing that makes an already-bad outage worse by dropping real call
// events — this only guards against a genuine flood, not normal traffic.
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

app.use('/auth', apiLimiter);

const { requireAuth, requireSupervisor } = authRoutes(app, supabase);

// /events doesn't run through requireAuth — it's Africa's Talking's own
// webhook callback, which can't carry an agent's session cookie. Opt-in
// (not enforced until the env var is set) because this URL is registered as
// a static callback URL in Africa's Talking's own dashboard — turning this
// on requires adding `?secret=...` there too, which isn't something this
// code can do on its own.
const AT_WEBHOOK_SECRET = process.env.AT_WEBHOOK_SECRET;
function verifyAtWebhookSecret(req, res, next) {
    if (!AT_WEBHOOK_SECRET) {
        console.warn(`⚠️  AT_WEBHOOK_SECRET not set — ${req.path} is reachable without authentication`);
        return next();
    }
    if (req.query.secret !== AT_WEBHOOK_SECRET) {
        return res.status(403).send('Forbidden');
    }
    next();
}

// Routes
app.use('/api', apiLimiter);
apiRoutes(app, supabase, requireAuth, requireSupervisor);

// Health check for DO App Platform's readiness/liveness probes — kept
// separate from '/' so visitors hitting the bare domain land in the
// actual dashboard instead of a bare status string.
app.get('/healthz', (req, res) => {
    res.send('✅ Chumz IVR running');
});

app.get('/', (req, res) => {
    res.redirect('/app');
});

// Old server-rendered dashboard is gone — send bookmarks to the React app.
app.get('/dashboard', (req, res) => {
    res.redirect('/app');
});


// 🔹 VOICE — Africa's Talking's account-wide Voice callback URL. Both
// directions on `+254711082161` now run as a genuine SIP trunk
// (`trunk:64.227.160.38` on AT's side, fixed 2026-08-19 — it had been
// misconfigured as their HTTPS-callback "SIP phone" product, which broke
// real inbound calls for about a week and required outbound to fake a
// `<Dial>` response just to get AT to connect the call at all). A real
// trunk delivers both directions over plain SIP with no HTTP involvement,
// so nothing should reach this URL anymore. Kept as a harmless no-op
// (confirmed live: an empty response never breaks anything, only ever
// fails to *rescue* a call AT is otherwise refusing to connect) rather
// than removed outright or a `<Hangup/>` — both of those were tried
// first, for the exact same "nothing should reach this URL" reasoning,
// and both actively killed real calls the two previous times this
// number's AT-side config silently drifted back to the HTTPS callback.
app.post('/voice', webhookLimiter, verifyAtWebhookSecret, (req, res) => {
    res.set('Content-Type', 'application/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});


// 🔹 EVENTS CALLBACK — Africa's Talking's legacy pre-trunk status webhook.
// Confirmed still live in production (2026-09-04: fresh events arriving
// alongside real, trunk-routed calls) despite the SIP trunk migration this
// was written against being long done — AT fires this independently of
// which delivery mechanism actually carries the call's media. Used to also
// upsert call_logs and flip a phone-matched agent offline; both removed
// (see DECISIONS.md): the call_logs write could only ever create a
// disconnected duplicate row (AT's own `ATVId_...` session id never matches
// the real Asterisk channel id ari-app logs under), and the agent-offline
// match only ever applied to the 2 of 10 agents still carrying a legacy
// `phone` value from before the SIP-softphone flow — a real hit would have
// force-flipped that agent offline via the *destination number happening to
// equal their phone*, even mid-call on their actual SIP line. Kept as a
// harmless no-op (same reasoning as /voice above) rather than removed
// outright, since AT's account-level Voice config still points at it.
app.post('/events', webhookLimiter, verifyAtWebhookSecret, (req, res) => {
    res.sendStatus(200);
});


// 🔹 REACT WEB APP (built via `npm run build` in /web, served under /app)
const webBuildPath = path.join(__dirname, '..', 'web', 'dist');
app.use('/app', express.static(webBuildPath));
app.get(['/app', '/app/*'], (req, res) => {
    res.sendFile(path.join(webBuildPath, 'index.html'), err => {
        if (err) res.status(404).send('Web app not built — run `npm run build` in /web first.');
    });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});

// DO App Platform sends SIGTERM on every redeploy/restart. Without this, a
// request in flight at that exact instant (an agent action, an AT /events
// callback) gets hard-killed mid-response instead of finishing normally —
// server.close() stops accepting new connections but lets in-flight ones
// complete; the timeout is a backstop against a request that never finishes
// on its own, so a deploy can't hang indefinitely waiting to exit.
process.on('SIGTERM', () => {
    console.log('⏳ SIGTERM received, closing server gracefully…');
    server.close(() => {
        console.log('✅ Server closed, exiting');
        process.exit(0);
    });
    setTimeout(() => {
        console.error('⚠️ Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, 10000).unref();
});
