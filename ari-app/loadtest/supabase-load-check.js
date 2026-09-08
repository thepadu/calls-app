#!/usr/bin/env node
// Real requests against the real Supabase project — the DB-layer half of
// the production-readiness plan's load-testing item (the other half,
// queue-simulation.js, tests ari-app's own in-memory logic with nothing
// real touched at all). This one is deliberately NOT run in CI or on any
// schedule: run it once, by hand, with a confirmed zero-active-calls
// window (same discipline as any other production check this project
// makes), and read the output — it doesn't clean anything up silently in
// the background afterward.
//
// Two halves:
//   - Read check: N concurrent requests mirroring the two real, high-
//     frequency dashboard polls (GET /api/queue's call_logs query, GET
//     /api/agents/available-count's agents query) — pure SELECTs, zero
//     mutation risk regardless of what this reports.
//   - Write check: M concurrent call_logs upserts, session_id prefixed
//     `loadtest-<runId>-` so they're unmistakable in the table, deleted
//     again at the end of this script REGARDLESS of whether the check
//     passed or failed (the delete runs in a finally block).
//
// Usage: node loadtest/supabase-load-check.js [readConcurrency] [writeConcurrency]
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// Same reasoning as ari-app/supabase.js's own createClient call: Node 20
// has no native WebSocket global, and supabase-js instantiates a Realtime
// client unconditionally even though this script never subscribes to
// anything — without this it throws before a single query runs.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    realtime: { transport: ws }
});

function percentile(sorted, p) {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

async function timed(fn) {
    const start = Date.now();
    const { error } = await fn();
    return { ms: Date.now() - start, error };
}

async function readCheck(concurrency) {
    console.log(`\n--- Read check: ${concurrency} concurrent requests, mirroring real dashboard polling ---`);

    const queueQuery = () =>
        supabase
            .from('call_logs')
            .select('*')
            .in('status', ['ivr_started', 'input_received', 'queued'])
            .order('created_at', { ascending: true });

    const availableCountQuery = () =>
        supabase.from('agents').select('id, last_seen_at, agent_sip_credentials(sip_username)').eq('status', 'available');

    const results = await Promise.all(
        Array.from({ length: concurrency }, (_, i) => timed(i % 2 === 0 ? queueQuery : availableCountQuery))
    );

    const errors = results.filter(r => r.error);
    const times = results.map(r => r.ms).sort((a, b) => a - b);

    console.log(`  Errors: ${errors.length} / ${concurrency}`);
    console.log(`  Latency — min ${times[0]}ms, p50 ${percentile(times, 50)}ms, p95 ${percentile(times, 95)}ms, max ${times[times.length - 1]}ms`);
    if (errors.length > 0) console.log('  First error:', errors[0].error.message);

    return { errors: errors.length, p95: percentile(times, 95) };
}

async function writeCheck(concurrency) {
    console.log(`\n--- Write check: ${concurrency} concurrent call_logs upserts, self-cleaning ---`);
    const runId = Date.now();
    const sessionIds = Array.from({ length: concurrency }, (_, i) => `loadtest-${runId}-${i}`);

    try {
        const results = await Promise.all(
            sessionIds.map(sessionId =>
                timed(() =>
                    supabase.from('call_logs').upsert(
                        { session_id: sessionId, caller: '254700000000', status: 'ivr_started', direction: 'Inbound' },
                        { onConflict: 'session_id' }
                    )
                )
            )
        );

        const errors = results.filter(r => r.error);
        const times = results.map(r => r.ms).sort((a, b) => a - b);

        console.log(`  Errors: ${errors.length} / ${concurrency}`);
        console.log(`  Latency — min ${times[0]}ms, p50 ${percentile(times, 50)}ms, p95 ${percentile(times, 95)}ms, max ${times[times.length - 1]}ms`);
        if (errors.length > 0) console.log('  First error:', errors[0].error.message);

        return { errors: errors.length, p95: percentile(times, 95) };
    } finally {
        console.log(`  Cleaning up ${sessionIds.length} loadtest- rows...`);
        const { error: deleteError, count } = await supabase
            .from('call_logs')
            .delete({ count: 'exact' })
            .like('session_id', `loadtest-${runId}-%`);
        if (deleteError) {
            console.error(`  ❌ CLEANUP FAILED — ${sessionIds.length} loadtest- rows may still be in call_logs:`, deleteError.message);
            console.error(`  Run manually: delete from call_logs where session_id like 'loadtest-${runId}-%';`);
        } else {
            console.log(`  Cleaned up ${count ?? sessionIds.length} row(s).`);
        }
    }
}

async function main() {
    const readConcurrency = Number(process.argv[2]) || 20;
    const writeConcurrency = Number(process.argv[3]) || 50;

    console.log(`Supabase load check — ${new Date().toISOString()}`);
    console.log(`(read: ${readConcurrency} concurrent, write: ${writeConcurrency} concurrent, both well above today's real traffic)`);

    const read = await readCheck(readConcurrency);
    const write = await writeCheck(writeConcurrency);

    console.log('\n--- Summary ---');
    console.log(`Read:  ${read.errors} errors, p95 ${read.p95}ms`);
    console.log(`Write: ${write.errors} errors, p95 ${write.p95}ms`);
    console.log(read.errors === 0 && write.errors === 0 ? '\n✅ No errors under this load.' : '\n❌ Errors occurred — see above.');
    process.exit(read.errors === 0 && write.errors === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Load check crashed:', err);
    process.exit(1);
});
