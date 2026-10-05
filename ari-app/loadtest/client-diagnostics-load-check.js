#!/usr/bin/env node
// Real requests against the real Supabase project — the DB-layer stress
// check for the client_diagnostics table added 2026-09-27/extended
// 2026-10-05 (see DECISIONS.md). Same shape and discipline as the existing
// supabase-load-check.js: run once by hand with a confirmed
// zero-active-calls window, self-cleaning, nothing left behind regardless
// of pass/fail.
//
// Why this needs its own script rather than reusing supabase-load-check.js:
// client_diagnostics has no session_id-style column to tag rows with for
// safe identification/cleanup, and its own write pattern is different —
// every established agent's softphone now writes one row every 20 seconds
// per active call (call_quality_sample) plus occasional ICE-restart/WS
// events, not a one-shot upsert per call like call_logs. The real question
// this answers: does that per-call periodic write rate hold up if many
// calls are bridged at once, and does the regenerate-route's own
// sliding-window COUNT query (calls-app/api.js's alert check) stay fast
// once the table has real volume in it.
//
// Usage: node loadtest/client-diagnostics-load-check.js [writeConcurrency]
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    realtime: { transport: ws }
});

// Distinct, greppable marker — not a session_id-style column to filter by,
// so cleanup matches on this exact string inside the free-text `detail`
// field instead (ilike, since Postgres has no plain "contains" for `eq`).
function loadtestDetail(runId, i) {
    return `loadtest-${runId} packetsLost=${i % 5} jitterMs=${(i % 40) + 5} rttMs=${(i % 100) + 20} path=relay`;
}

function percentile(sorted, p) {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

async function timed(fn) {
    const start = Date.now();
    const { error } = await fn();
    return { ms: Date.now() - start, error };
}

async function writeCheck(concurrency) {
    console.log(`\n--- Write check: ${concurrency} concurrent client_diagnostics inserts (simulating call_quality_sample traffic), self-cleaning ---`);
    const runId = Date.now();

    try {
        const results = await Promise.all(
            Array.from({ length: concurrency }, (_, i) =>
                timed(() =>
                    supabase.from('client_diagnostics').insert({
                        agent_id: null, // avoids the agents FK and never touches the real per-agent alert counter
                        event_type: 'call_quality_sample',
                        call_duration_seconds: (i % 180) + 20,
                        detail: loadtestDetail(runId, i)
                    })
                )
            )
        );

        const errors = results.filter(r => r.error);
        const times = results.map(r => r.ms).sort((a, b) => a - b);

        console.log(`  Errors: ${errors.length} / ${concurrency}`);
        console.log(`  Latency — min ${times[0]}ms, p50 ${percentile(times, 50)}ms, p95 ${percentile(times, 95)}ms, max ${times[times.length - 1]}ms`);
        if (errors.length > 0) console.log('  First error:', errors[0].error.message);

        return { errors: errors.length, p95: percentile(times, 95), runId };
    } finally {
        console.log(`  Cleaning up loadtest-${runId} rows...`);
        const { error: deleteError, count } = await supabase
            .from('client_diagnostics')
            .delete({ count: 'exact' })
            .ilike('detail', `loadtest-${runId}%`);
        if (deleteError) {
            console.error(`  ❌ CLEANUP FAILED — rows may still be in client_diagnostics:`, deleteError.message);
            console.error(`  Run manually: delete from client_diagnostics where detail ilike 'loadtest-${runId}%';`);
        } else {
            console.log(`  Cleaned up ${count ?? concurrency} row(s).`);
        }
    }
}

// Mirrors the exact query calls-app/api.js's POST /api/client-diagnostics
// runs after a concerning event (ice_restart_failed/ws_disconnect) — a
// head-only count over a 1-hour window for one agent. Run against whatever
// real historical volume already exists in the table, not the loadtest
// rows above (which use agent_id: null and are gone by the time this
// runs), so this reflects real current table size, not inflated by this
// script's own writes.
async function alertQueryCheck(agentId) {
    console.log(`\n--- Alert-path query check: the same sliding-window COUNT the regenerate route runs, for agent ${agentId} ---`);
    const { ms, error } = await timed(() =>
        supabase
            .from('client_diagnostics')
            .select('id', { count: 'exact', head: true })
            .eq('agent_id', agentId)
            .in('event_type', ['ice_restart_failed', 'ws_disconnect'])
            .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
    );
    console.log(`  Latency: ${ms}ms${error ? ` — ERROR: ${error.message}` : ''}`);
    return { ms, error };
}

async function main() {
    const writeConcurrency = Number(process.argv[2]) || 50;
    const agentId = Number(process.argv[3]) || 1;

    console.log(`client_diagnostics load check — ${new Date().toISOString()}`);
    console.log(`(write: ${writeConcurrency} concurrent — well above today's real concurrent-call count)`);

    const write = await writeCheck(writeConcurrency);
    const alertQuery = await alertQueryCheck(agentId);

    console.log('\n--- Summary ---');
    console.log(`Write: ${write.errors} errors, p95 ${write.p95}ms`);
    console.log(`Alert-path query: ${alertQuery.ms}ms${alertQuery.error ? ' (errored)' : ''}`);
    const ok = write.errors === 0 && !alertQuery.error;
    console.log(ok ? '\n✅ No errors under this load.' : '\n❌ Errors occurred — see above.');
    process.exit(ok ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Load check crashed:', err);
    process.exit(1);
});
