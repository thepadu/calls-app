#!/usr/bin/env node
// Originates N real Local channels directly into Asterisk's dialplan at a
// TEMPORARY [loadtest-inbound] context (added by hand for this test, see
// DECISIONS.md's 2026-09-08 entry) whose only job is Stasis(chumz-ivr) with
// no args — identical in effect to the real [from-at-trunk] context. Every
// channel this originates is processed by the real, unmodified ari-app
// code: real IVR menu, real Piper TTS synthesis, real queue entry, real
// ring-all, real Supabase writes. What it does NOT exercise: Africa's
// Talking's own network or real external SIP/RTP transport — these are
// Local channels, not real inbound calls from the PSTN. See DECISIONS.md
// for why (the AT Voice API's Make Call is built for real external
// destinations, not a documented loopback into your own trunk).
//
// Run directly on the VPS (needs a live ARI connection + the real
// [loadtest-inbound] context to already exist — this script does not
// create it). Requires zero real agents logged in for the duration, so
// test calls don't ring anyone's real softphone.
//
// Usage: node loadtest/asterisk-channel-load-test.js [numCalls] [hangupAfterSeconds]
//
// One originated call = TWO real Stasis entries: a Local channel always has
// two linked halves, and both independently run the dialplan location given
// (confirmed live, 2026-09-08 — 20 originated calls produced 40 "📞 Inbound
// call" log lines and 40 active channels at peak). Hanging up the one
// channel id this script tracks per call still correctly takes its paired
// half down too — confirmed live, channel count returned to 0 after this
// script's own hangup loop, not left with 20 orphaned halves.
require('dotenv').config();
const ari = require('ari-client');

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USERNAME = process.env.ARI_USERNAME;
const ARI_PASSWORD = process.env.ARI_PASSWORD;
const APP_NAME = process.env.ARI_APP_NAME || 'chumz-ivr';

// Every originated channel's caller ID gets this prefix — trivially
// identifiable in call_logs afterward for cleanup, and can never collide
// with a real Kenyan mobile number (which never starts 2547000000).
const CALLER_PREFIX = '254700000';

async function main() {
    const numCalls = Number(process.argv[2]) || 10;
    const hangupAfterSeconds = Number(process.argv[3]) || 8;

    console.log(`Connecting to ARI at ${ARI_URL}...`);
    const client = await ari.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD);
    // Deliberately never calls client.start(APP_NAME) — that would register
    // a SECOND listener for the same 'chumz-ivr' Stasis app the real,
    // already-running ari-app process is connected to, and it's genuinely
    // unclear (and not worth risking on live production traffic to find
    // out) how Asterisk fans out events across two clients on one app name.
    // originate()/hangup() below are plain REST calls that don't need this
    // connection to be "started" — the channels they create still enter
    // the real 'chumz-ivr' app via the dialplan's own Stasis() line, and
    // the real ari-app process (already listening) is what actually
    // receives their StasisStart events, exactly as intended.
    console.log(`Connected. Originating ${numCalls} real Local channels into [loadtest-inbound]...`);

    const channels = [];
    const startedAt = Date.now();

    for (let i = 1; i <= numCalls; i++) {
        const callerId = `${CALLER_PREFIX}${String(i).padStart(3, '0')}`;
        try {
            const channel = await client.channels.originate({
                endpoint: `Local/${callerId}@loadtest-inbound`,
                context: 'loadtest-inbound',
                extension: callerId,
                priority: 1,
                callerId,
                timeout: 30
            });
            channels.push({ id: channel.id, callerId });
            console.log(`  [${i}/${numCalls}] originated ${channel.id} (caller ${callerId})`);
        } catch (err) {
            console.error(`  [${i}/${numCalls}] ❌ failed to originate:`, err.message);
        }
    }

    console.log(`\nAll ${channels.length} channels originated in ${Date.now() - startedAt}ms.`);
    console.log(`Letting them run for ${hangupAfterSeconds}s (IVR greeting + queue entry), then hanging up...`);

    await new Promise(resolve => setTimeout(resolve, hangupAfterSeconds * 1000));

    console.log('\nHanging up all test channels...');
    let hungUp = 0;
    for (const { id } of channels) {
        try {
            await client.channels.hangup({ channelId: id });
            hungUp++;
        } catch (err) {
            // Already gone (e.g. it hit the dialplan's own Hangup() already,
            // or was already abandoned by ari-app) — not an error.
            if (!String(err.message || err).includes('Channel not found')) {
                console.error(`  ❌ failed to hang up ${id}:`, err.message);
            }
        }
    }
    console.log(`Hung up ${hungUp} / ${channels.length} channels (rest had already ended on their own).`);

    // No client.stop() — this connection was never client.start()'d (see
    // the comment above), so there's no listening WebSocket to close;
    // process.exit() below is enough to end the plain REST connection.
    console.log('\nDone. Now: confirm `core show channels count` is 0, then clean up.');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Load test crashed:', err);
    process.exit(1);
});
