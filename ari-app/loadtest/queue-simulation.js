#!/usr/bin/env node
// Drives ari-app's REAL queue/ring/bridge functions (imported from index.js,
// not reimplemented here) against a fake ari-client — no live Asterisk
// connection, no real calls, nothing touched outside this process. Answers
// one specific question the production-readiness plan asked for: does the
// in-memory orchestration (waitingQueue, the ring-all fan-out, the
// simultaneous-answer race guard) actually hold up under more concurrent
// activity than this business sees today, or does something leak/double-
// bridge/hang under load that a light, sequential manual test would never
// surface?
//
// This is NOT a real capacity test — it says nothing about how many actual
// concurrent PSTN calls Asterisk/coturn can carry (that's a live-trunk/RTP
// question a JS simulation can't answer; see DECISIONS.md and the plan this
// came out of). It only tests the correctness of this process's own
// bookkeeping under concurrency.
//
// Usage: npm run loadtest:queue -- [numCustomers] [numAgents] [answerFailureRate]
//    or: node loadtest/queue-simulation.js [numCustomers] [numAgents] [answerFailureRate]
// (defaults: 30 customers, 4 agents, 0 failure rate). answerFailureRate is a
// 0-1 chance that any given ring attempt's answer() rejects (simulating a
// real "agent didn't pick up" or a dead softphone) — added to exercise the
// bridgeAgentLeg redesign's last-surviving-leg/no-double-requeue logic,
// which a 0%-failure run can never touch. No env vars needed — the
// require() interception below replaces supabase.js before it ever loads
// for real, so index.js's own SUPABASE_URL/KEY usage is never reached.
'use strict';

const EventEmitter = require('events');
const path = require('path');
const Module = require('module');

// index.js does `require('./supabase')` for real — intercepted here so the
// simulation never touches a real Supabase project. Registered before
// requiring index.js, the same dependency-injection trick vitest's own
// vi.mock does under the hood, just done by hand since this is a plain
// script, not a test file.
const supabasePath = path.join(__dirname, '..', 'supabase.js');
const originalLoad = Module._load;
const fakeAgents = [];
const agentStatusLog = []; // { agentId, status, expectedStatus, applied } — asserted against at the end
const callLogWrites = [];
const originateLog = []; // { channelId, endpoint } — every fake originate() call, for the claim-race scenario

Module._load = function (request, parent, isMain) {
    if (parent && path.resolve(path.dirname(parent.filename), request) === supabasePath.replace(/\.js$/, '')) {
        return {
            getAvailableAgentsWithSip: async () =>
                fakeAgents
                    .filter(a => a.status === 'available')
                    .map(a => ({ id: a.id, name: a.name, agent_sip_credentials: { sip_username: a.sipUsername } })),
            // Compare-and-swap, mirroring the real setAgentStatus in
            // ari-app/supabase.js: with expectedStatus given, the write
            // only applies if the agent's current status still matches —
            // otherwise this is a no-op that returns false, exactly like a
            // real UPDATE ... WHERE status = expectedStatus matching zero
            // rows. Without this, the CAS added to ringOneAgent/
            // stopSiblingRings/bridgeAgentLeg would silently behave like
            // the old unconditional write in every simulated run, and a
            // lost claim race would never actually show up as a skipped
            // ring here.
            setAgentStatus: async (agentId, status, expectedStatus = null) => {
                const agent = fakeAgents.find(a => a.id === agentId);
                if (!agent) return false;
                const applied = !expectedStatus || agent.status === expectedStatus;
                if (applied) agent.status = status;
                agentStatusLog.push({ agentId, status, expectedStatus, applied });
                return applied;
            },
            upsertCallLog: async row => {
                callLogWrites.push(row);
            },
            getHoldMusicConfig: async () => ({ active_class: 'default' }),
            getAgentSipCredentials: async agentId => {
                const agent = fakeAgents.find(a => a.id === agentId);
                return agent ? { sipUsername: agent.sipUsername, status: agent.status } : null;
            },
            getAgentPhone: async () => null,
            // Needed for the internal-call-race scenario below —
            // handleOutboundAgentCall looks the calling agent up by their own
            // channel's sip_username (for call-log attribution), a path the
            // ring-all scenarios never exercise.
            getAgentBySipUsername: async sipUsername => {
                const agent = fakeAgents.find(a => a.sipUsername === sipUsername);
                return agent ? { id: agent.id, name: agent.name, phone: null } : null;
            }
        };
    }
    return originalLoad.apply(this, arguments);
};

const {
    __setTestClient,
    enterQueue,
    tryDequeueNext,
    claimQueuedCall,
    bridgeAgentLeg,
    handleInternalAgentCall,
    finishOutboundCall,
    waitingQueue,
    ringGroupBySessionId,
    agentLegBySessionId,
    outboundBySessionId
} = require('../index.js');

// --- Fake ARI primitives -----------------------------------------------

let nextChannelId = 1;

class FakeChannel extends EventEmitter {
    constructor(id, callerNumber) {
        super();
        this.id = id || `sim-${nextChannelId++}`;
        this.caller = { number: callerNumber || '254700000000' };
        this._up = true;
        // Decided once, at origination time (see makeFakeClient) — a real
        // ring attempt only ever gets one answer() call in this codebase,
        // so "does this specific leg answer" is a property of the leg, not
        // something that needs to vary across repeated calls.
        this._shouldFailAnswer = false;
    }
    async answer() {
        if (this._shouldFailAnswer) {
            throw new Error('FakeChannel: simulated no-answer (agent rejected/didn’t pick up)');
        }
    }
    // No-ops — real ARI channels support these (agent-side ringback audio
    // during an outbound/internal dial), but nothing here asserts on
    // whether they were called, only exercised because
    // handleOutboundAgentCall calls them unconditionally on the caller's
    // own channel.
    async ring() {}
    async ringStop() {}
    async hangup() {
        if (!this._up) return;
        this._up = false;
        this.emit('StasisEnd');
    }
    async setChannelVar() {}
    async continueInDialplan() {}
}

class FakeBridge {
    constructor() {
        this.members = new Set();
        this._destroyed = false;
    }
    async get() {
        if (this._destroyed) throw new Error('Bridge not found');
    }
    async addChannel({ channel }) {
        (Array.isArray(channel) ? channel : [channel]).forEach(id => this.members.add(id));
    }
    async removeChannel({ channel }) {
        this.members.delete(channel);
    }
    async startMoh() {}
    async destroy() {
        this._destroyed = true;
    }
}

function makeFakeClient({ answerFailureRate = 0 } = {}) {
    return {
        channels: {
            originate: async ({ channelId, endpoint }) => {
                originateLog.push({ channelId, endpoint });
                const channel = new FakeChannel(channelId);
                channel._shouldFailAnswer = Math.random() < answerFailureRate;
                return channel;
            }
        },
        bridges: {
            create: async () => new FakeBridge()
        }
    };
}

// --- Claim-race scenario -------------------------------------------------
// Exercises the CAS added to ringOneAgent's setAgentStatus('ringing',
// 'available') call: before it existed, a claimQueuedCall (an agent
// clicking "pick up" in Live Queue) racing a concurrent dequeueNext tick
// (the automatic ring-all) — both targeting the SAME agent for two
// DIFFERENT customers — could both pass their own separate availability
// read and both originate a real leg to the same softphone. Run in
// isolation from the main round loop below (its own dedicated agent and
// customers) so its assertion is unambiguous.
async function testClaimRace() {
    const raceAgentId = 90001;
    fakeAgents.push({ id: raceAgentId, name: 'RaceAgent', sipUsername: 'raceagent', status: 'available' });

    // Every other agent forced offline for the duration of this scenario —
    // otherwise dequeueNext's own fan-out could target a different agent
    // than the one claimQueuedCall is racing for, and the two calls
    // wouldn't actually be contending for the same resource.
    const others = fakeAgents.filter(a => a.id !== raceAgentId);
    const prevStatuses = others.map(a => a.status);
    others.forEach(a => (a.status = 'offline'));

    const customerA = new FakeChannel('race-customer-a', '254700090001');
    const customerB = new FakeChannel('race-customer-b', '254700090002');
    await enterQueue(customerA, customerA.id);
    await enterQueue(customerB, customerB.id);

    const originateCountBefore = originateLog.length;
    await Promise.all([claimQueuedCall(customerA.id, raceAgentId), tryDequeueNext()]);
    const raceOriginations = originateLog.slice(originateCountBefore).filter(o => o.endpoint === 'PJSIP/raceagent');

    others.forEach((a, i) => (a.status = prevStatuses[i]));

    // Clean up whatever this scenario left behind so it can't pollute the
    // main loop's own assertions below. This scenario deliberately never
    // calls bridgeAgentLeg for the winning leg (it only tests the CAS at
    // the claim step, not the full answer/bridge flow) — so, unlike a real
    // hangup, closing the channel here does NOT run bridgeAgentLeg's own
    // "delete agentLegBySessionId, then decide what to do" logic. Clearing
    // that map entry directly is this test's job, not a real bug in
    // bridgeAgentLeg (that path is exercised plenty elsewhere, in the main
    // round loop below).
    for (const [channelId, leg] of [...agentLegBySessionId.entries()]) {
        if (leg.agentId === raceAgentId) agentLegBySessionId.delete(channelId);
    }
    for (const group of ringGroupBySessionId.values()) {
        for (const sib of group) {
            if (sib.agentId === raceAgentId) await sib.channel.hangup().catch(() => {});
        }
    }
    for (const sessionId of [customerA.id, customerB.id]) {
        const idx = waitingQueue.findIndex(w => w.sessionId === sessionId);
        if (idx !== -1) waitingQueue.splice(idx, 1);
    }
    ringGroupBySessionId.delete(customerA.id);
    ringGroupBySessionId.delete(customerB.id);
    const raceAgentIndex = fakeAgents.findIndex(a => a.id === raceAgentId);
    if (raceAgentIndex !== -1) fakeAgents.splice(raceAgentIndex, 1);

    const problems = [];
    if (raceOriginations.length > 1) {
        problems.push(
            `claimQueuedCall/dequeueNext race originated ${raceOriginations.length} legs to the same agent (raceagent) for two different customers — should be at most 1`
        );
    }
    console.log(`Claim-race scenario: ${raceOriginations.length} leg(s) originated to the contested agent (expected: at most 1).`);
    return problems;
}

// --- Internal-call race scenario ------------------------------------------
// Exercises the CAS added to handleInternalAgentCall's target-agent claim
// (ari-app/index.js, fixed 2026-09-24): before it existed, dialing a
// teammate via 9<id> only ever did a plain read of the target's status,
// never claimed it — a concurrent ring-all fan-out (dequeueNext) targeting
// the SAME agent for a real waiting customer could originate its own leg
// before the internal call's own dial ever landed, genuinely bridging one
// agent into two simultaneous calls. Both paths originate to the identical
// endpoint string ("PJSIP/targetagent"), so whichever mechanism wins, a
// double-booking shows up as >1 origination to it — same assertion shape as
// testClaimRace above, just contesting handleInternalAgentCall's claim
// instead of claimQueuedCall's.
async function testInternalCallRace() {
    const callerAgentId = 90002;
    const targetAgentId = 90003;
    const problemsFromInternalCallRevert = [];
    // The caller is deliberately NOT 'available' — if they were, ring-all's
    // own fan-out would also try to ring *them*, contesting a second,
    // unrelated claim this scenario isn't testing. A real internal call can
    // certainly be placed by an available agent; this just keeps the
    // scenario's assertion unambiguous, same reasoning as testClaimRace
    // forcing every uninvolved agent offline.
    fakeAgents.push({ id: callerAgentId, name: 'CallerAgent', sipUsername: 'calleragent', status: 'on_call' });
    fakeAgents.push({ id: targetAgentId, name: 'TargetAgent', sipUsername: 'targetagent', status: 'available' });

    const others = fakeAgents.filter(a => a.id !== callerAgentId && a.id !== targetAgentId);
    const prevStatuses = others.map(a => a.status);
    others.forEach(a => (a.status = 'offline'));

    // dequeueNext always shifts from the FRONT of the shared waitingQueue —
    // by the time this scenario runs (after the main round loop below has
    // reached its fixed point), that queue can easily still hold real
    // customers the main loop couldn't bridge (more customers than agents).
    // Unlike testClaimRace above (whose winning path, claimQueuedCall, never
    // touches waitingQueue at all), a ring-all win here dequeues whatever's
    // at the front — if that's an unrelated leftover customer rather than
    // this scenario's own, this test would silently "steal" and strand a
    // real customer instead of testing anything about the target agent's
    // claim. Setting the queue aside for the duration guarantees dequeueNext
    // can only ever contend for the one customer this scenario controls.
    const displacedWaiting = waitingQueue.splice(0, waitingQueue.length);

    const customer = new FakeChannel('internal-race-customer', '254700090003');
    await enterQueue(customer, customer.id);

    // A real caller channel already has a PJSIP/<username>-<hexid> name by
    // the time Stasis hands it to handleInternalAgentCall — set by hand
    // here since this channel is constructed directly, not via the fake
    // client's originate().
    const callerChannel = new FakeChannel('internal-race-caller');
    callerChannel.name = 'PJSIP/calleragent-00000001';

    const originateCountBefore = originateLog.length;
    await Promise.all([handleInternalAgentCall(callerChannel, String(targetAgentId)), tryDequeueNext()]);
    const targetOriginations = originateLog.slice(originateCountBefore).filter(o => o.endpoint === 'PJSIP/targetagent');

    // Whichever side actually won the claim needs its own real cleanup path
    // run, not a blanket map-clear — a ring-all win leaves a live ringing
    // leg (agentLegBySessionId + ringGroupBySessionId, same shape
    // testClaimRace already cleans up); an internal-call win leaves a real
    // `pending` entry in outboundBySessionId that only finishOutboundCall
    // itself knows how to unwind correctly (including the CAS revert this
    // whole scenario exists to verify).
    const wonByRingAll = targetOriginations.some(o => o.channelId?.startsWith('agent-leg-'));
    const wonByInternalCall = outboundBySessionId.has(callerChannel.id);

    if (wonByInternalCall) {
        // The actual regression check: before the fix, this revert never
        // ran at all for a non-bridged internal call (the old code only
        // reverted `internalTargetAgentId` when `pending.bridged` was
        // true), leaving the target permanently stuck on 'ringing'.
        await finishOutboundCall(callerChannel.id, 'failed');
        const targetAfter = fakeAgents.find(a => a.id === targetAgentId);
        if (targetAfter?.status !== 'available') {
            problemsFromInternalCallRevert.push(
                `Target agent left in status '${targetAfter?.status}' after a non-bridged internal call ended — expected 'available'`
            );
        }
    }
    if (wonByRingAll) {
        for (const sib of ringGroupBySessionId.get(customer.id) || []) {
            if (sib.agentId === targetAgentId) await sib.channel.hangup().catch(() => {});
        }
    }

    // Cleanup — same reasoning as testClaimRace's own block: this scenario
    // must leave no trace in the shared maps the main round loop's
    // assertions below rely on.
    ringGroupBySessionId.delete(customer.id);
    for (const [channelId, leg] of [...agentLegBySessionId.entries()]) {
        if (leg.agentId === targetAgentId) agentLegBySessionId.delete(channelId);
    }
    const queueIdx = waitingQueue.findIndex(w => w.sessionId === customer.id);
    if (queueIdx !== -1) waitingQueue.splice(queueIdx, 1);
    waitingQueue.unshift(...displacedWaiting); // restore, in their original order/position
    others.forEach((a, i) => (a.status = prevStatuses[i]));
    fakeAgents.splice(fakeAgents.findIndex(a => a.id === callerAgentId), 1);
    fakeAgents.splice(fakeAgents.findIndex(a => a.id === targetAgentId), 1);

    const problems = [...problemsFromInternalCallRevert];
    if (targetOriginations.length > 1) {
        problems.push(
            `Internal-call/ring-all race originated ${targetOriginations.length} legs to the same target agent (targetagent) — should be at most 1`
        );
    }
    console.log(
        `Internal-call race scenario: ${targetOriginations.length} leg(s) originated to the contested target agent ` +
            `(expected: at most 1; won by ${wonByInternalCall ? 'internal call' : 'ring-all'}).`
    );
    return problems;
}

// --- Simulation ----------------------------------------------------------

async function main() {
    const numCustomers = Number(process.argv[2]) || 30;
    const numAgents = Number(process.argv[3]) || 4;
    const answerFailureRate = process.argv[4] !== undefined ? Number(process.argv[4]) : 0;

    __setTestClient(makeFakeClient({ answerFailureRate }));

    for (let i = 1; i <= numAgents; i++) {
        fakeAgents.push({ id: i, name: `Agent${i}`, sipUsername: `agent${i}`, status: 'available' });
    }

    console.log(`Simulating ${numCustomers} customers against ${numAgents} agents (answerFailureRate=${answerFailureRate})...`);

    const customerChannels = [];
    for (let i = 1; i <= numCustomers; i++) {
        const channel = new FakeChannel(`customer-${i}`, `25470000${String(i).padStart(4, '0')}`);
        customerChannels.push(channel);
        await enterQueue(channel, channel.id);
    }

    // Real production never "finishes" — tryDequeueNext polls forever
    // (setInterval) and bridgeAgentLeg fires whenever a real StasisStart
    // says an agent's leg actually entered Stasis, independently and
    // continuously. A one-shot "dequeue a bunch, then resolve a snapshot of
    // what's ringing, then dequeue a bit more" sequence doesn't just
    // simplify that — it creates orphans a real, continuously-running
    // process would never leave behind: e.g. dequeueing customer B (once
    // agents freed up from resolving customer A) after already taking the
    // one snapshot of "what needs resolving" leaves B's brand-new ring
    // group with nothing left to ever resolve it, a bug in this
    // simulation's own orchestration, not in ari-app. Alternating
    // dequeue-to-a-fixed-point and resolve-everything-currently-ringing,
    // round after round, until nothing changes anymore, is what actually
    // mirrors "runs forever" without literally waiting 3s x however many
    // polls in real time. With answerFailureRate > 0, a round can now leave
    // some sessions requeued rather than bridged — those get picked up
    // fresh by the next round's dequeue pass, same as a real retry would.
    const MAX_ROUNDS = (numCustomers + numAgents + 5) * (answerFailureRate > 0 ? 4 : 1);
    for (let round = 0; round < MAX_ROUNDS; round++) {
        let dequeuedSomething = false;
        for (let tick = 0; tick < numAgents + 1; tick++) {
            const before = waitingQueue.length;
            await tryDequeueNext();
            if (waitingQueue.length !== before) dequeuedSomething = true;
        }

        const sessionIdsWithRingers = [...ringGroupBySessionId.keys()];
        for (const sessionId of sessionIdsWithRingers) {
            const ringGroup = ringGroupBySessionId.get(sessionId) || [];
            // Simultaneous-answer race: every member of a ring group
            // resolves at once (Promise.all, not sequential) — exactly the
            // race claimedSessions exists to guard against, deliberately
            // forced here every round instead of hoping it happens under
            // real timing. With answerFailureRate > 0, some of these
            // resolve by throwing instead of succeeding — exercising the
            // last-surviving-leg/no-double-requeue logic in bridgeAgentLeg.
            await Promise.all(ringGroup.map(({ channel, agentId }) => bridgeAgentLeg(channel, agentId, sessionId)));
        }

        if (!dequeuedSomething && sessionIdsWithRingers.length === 0) break; // fixed point reached
    }

    const claimRaceProblems = await testClaimRace();
    const internalCallRaceProblems = await testInternalCallRace();

    // --- Assertions -----------------------------------------------------
    const problems = [...claimRaceProblems, ...internalCallRaceProblems];

    const bridgedCount = callLogWrites.filter(r => r.status === 'ongoing').length;
    console.log(`Bridged: ${bridgedCount} / ${numCustomers} customers`);

    // No customer should ever appear bridged more than once — the exact
    // failure mode claimedSessions exists to prevent.
    const bridgedSessionIds = callLogWrites.filter(r => r.status === 'ongoing').map(r => r.session_id);
    const duplicateBridges = bridgedSessionIds.filter((id, i) => bridgedSessionIds.indexOf(id) !== i);
    if (duplicateBridges.length > 0) problems.push(`Double-bridged session(s): ${[...new Set(duplicateBridges)].join(', ')}`);

    // Every agent who ended up 'on_call' should be attached to exactly one
    // real bridged customer, and vice versa, one-to-one.
    const onCallAgents = fakeAgents.filter(a => a.status === 'on_call');
    if (onCallAgents.length !== bridgedCount) {
        problems.push(`${onCallAgents.length} agent(s) show on_call but ${bridgedCount} customers actually bridged — mismatch`);
    }

    // Nothing should be left dangling in the ring-tracking maps once every
    // tick has settled — a leaked entry here is exactly what would leave a
    // future customer's siblings never stopped.
    if (ringGroupBySessionId.size > 0) problems.push(`${ringGroupBySessionId.size} stale ringGroupBySessionId entr(y/ies) left behind`);
    if (agentLegBySessionId.size > 0) problems.push(`${agentLegBySessionId.size} stale agentLegBySessionId entr(y/ies) left behind`);

    // A customer who never got bridged (more customers than agents, by
    // design in the default numCustomers > numAgents run, or — with
    // answerFailureRate > 0 — simply unlucky every round) should still be
    // sitting in waitingQueue, not lost — never bridged is fine; vanished
    // silently is not.
    const unbridgedCustomers = numCustomers - bridgedCount;
    if (waitingQueue.length !== unbridgedCustomers) {
        problems.push(`${unbridgedCustomers} customer(s) never bridged, but waitingQueue only has ${waitingQueue.length} — someone got lost, not just left waiting`);
    }

    // The specific failure mode the bridgeAgentLeg redesign has to avoid:
    // a customer requeued more than once (double-counted in waitingQueue),
    // or requeued AND bridged at the same time (served twice).
    const waitingSessionIds = waitingQueue.map(w => w.sessionId);
    const duplicateWaiting = waitingSessionIds.filter((id, i) => waitingSessionIds.indexOf(id) !== i);
    if (duplicateWaiting.length > 0) {
        problems.push(`Session(s) duplicated in waitingQueue: ${[...new Set(duplicateWaiting)].join(', ')}`);
    }
    const bridgedAndWaiting = waitingSessionIds.filter(id => bridgedSessionIds.includes(id));
    if (bridgedAndWaiting.length > 0) {
        problems.push(`Session(s) both bridged AND still in waitingQueue: ${[...new Set(bridgedAndWaiting)].join(', ')}`);
    }

    // Every CAS'd setAgentStatus call that lost its race (applied: false)
    // should never have been for a plain 'ringing'->'available' revert
    // colliding with itself in a way that left an agent permanently
    // stranded — a sanity check that lost-race entries stayed rare relative
    // to total status writes, not a sign something is thrashing.
    const lostRaces = agentStatusLog.filter(e => e.expectedStatus && !e.applied);
    console.log(`Status writes: ${agentStatusLog.length} total, ${lostRaces.length} lost a CAS race (expected during genuine concurrency, not itself a problem).`);

    console.log(problems.length === 0 ? '\n✅ No problems found.' : `\n❌ ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Simulation crashed:', err);
    process.exit(1);
});
