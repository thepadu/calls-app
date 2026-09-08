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
// Usage: npm run loadtest:queue -- [numCustomers] [numAgents]
//    or: node loadtest/queue-simulation.js [numCustomers] [numAgents]
// (defaults: 30 customers, 4 agents). No env vars needed — the require()
// interception below replaces supabase.js before it ever loads for real,
// so index.js's own SUPABASE_URL/KEY usage is never reached.
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
const agentStatusLog = []; // { agentId, status } — asserted against at the end
const callLogWrites = [];

Module._load = function (request, parent, isMain) {
    if (parent && path.resolve(path.dirname(parent.filename), request) === supabasePath.replace(/\.js$/, '')) {
        return {
            getAvailableAgentsWithSip: async () =>
                fakeAgents
                    .filter(a => a.status === 'available')
                    .map(a => ({ id: a.id, name: a.name, agent_sip_credentials: { sip_username: a.sipUsername } })),
            setAgentStatus: async (agentId, status) => {
                const agent = fakeAgents.find(a => a.id === agentId);
                if (agent) agent.status = status;
                agentStatusLog.push({ agentId, status });
            },
            upsertCallLog: async row => {
                callLogWrites.push(row);
            },
            getHoldMusicConfig: async () => ({ active_class: 'default' }),
            getAgentSipCredentials: async agentId => {
                const agent = fakeAgents.find(a => a.id === agentId);
                return agent ? { sipUsername: agent.sipUsername, status: agent.status } : null;
            },
            getAgentPhone: async () => null
        };
    }
    return originalLoad.apply(this, arguments);
};

// claimedSessions is exported too but not directly asserted on below — its
// effect is already what's being tested (no double-bridge, see the
// assertions) rather than something to inspect separately. claimQueuedCall
// (the manual "pick up this specific caller" path, a distinct race between
// a supervisor's click and the automatic ring-all) isn't covered by this
// script yet — a natural next scenario to add here, not attempted in this
// pass.
const {
    __setTestClient,
    enterQueue,
    tryDequeueNext,
    bridgeAgentLeg,
    waitingQueue,
    ringGroupBySessionId,
    agentLegBySessionId
} = require('../index.js');

// --- Fake ARI primitives -----------------------------------------------

let nextChannelId = 1;

class FakeChannel extends EventEmitter {
    constructor(id, callerNumber) {
        super();
        this.id = id || `sim-${nextChannelId++}`;
        this.caller = { number: callerNumber || '254700000000' };
        this._up = true;
    }
    async answer() {}
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

function makeFakeClient() {
    return {
        channels: {
            originate: async ({ channelId }) => new FakeChannel(channelId)
        },
        bridges: {
            create: async () => new FakeBridge()
        }
    };
}

// --- Simulation ----------------------------------------------------------

async function main() {
    const numCustomers = Number(process.argv[2]) || 30;
    const numAgents = Number(process.argv[3]) || 4;

    __setTestClient(makeFakeClient());

    for (let i = 1; i <= numAgents; i++) {
        fakeAgents.push({ id: i, name: `Agent${i}`, sipUsername: `agent${i}`, status: 'available' });
    }

    console.log(`Simulating ${numCustomers} customers against ${numAgents} agents...`);

    const customerChannels = [];
    for (let i = 1; i <= numCustomers; i++) {
        const channel = new FakeChannel(`customer-${i}`, `25470000${String(i).padStart(4, '0')}`);
        customerChannels.push(channel);
        await enterQueue(channel, channel.id);
    }

    // Real production never "finishes" — tryDequeueNext polls forever
    // (setInterval) and bridgeAgentLeg fires whenever a real StasisStart
    // says an agent's leg actually answered, independently and continuously.
    // A one-shot "dequeue a bunch, then answer a snapshot of what's ringing,
    // then dequeue a bit more" sequence doesn't just simplify that — it
    // creates orphans a real, continuously-running process would never
    // leave behind: e.g. dequeueing customer B (once agents freed up from
    // resolving customer A) after already taking the one snapshot of "what
    // needs answering" leaves B's brand-new ring group with nothing left to
    // ever resolve it, a bug in this simulation's own orchestration, not in
    // ari-app. Alternating dequeue-to-a-fixed-point and answer-everything-
    // currently-ringing, round after round, until nothing changes anymore,
    // is what actually mirrors "runs forever" without literally waiting
    // 3s x however many polls in real time.
    const MAX_ROUNDS = numCustomers + numAgents + 5;
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
            // "answers" at once (Promise.all, not sequential) — exactly the
            // race claimedSessions exists to guard against, deliberately
            // forced here every round instead of hoping it happens under
            // real timing.
            await Promise.all(ringGroup.map(({ channel, agentId }) => bridgeAgentLeg(channel, agentId, sessionId)));
        }

        if (!dequeuedSomething && sessionIdsWithRingers.length === 0) break; // fixed point reached
    }

    // --- Assertions -----------------------------------------------------
    const problems = [];

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
    // design in the default numCustomers > numAgents run) should still be
    // sitting in waitingQueue, not lost — never bridged is fine; vanished
    // silently is not.
    const unbridgedCustomers = numCustomers - bridgedCount;
    if (waitingQueue.length !== unbridgedCustomers) {
        problems.push(`${unbridgedCustomers} customer(s) never bridged, but waitingQueue only has ${waitingQueue.length} — someone got lost, not just left waiting`);
    }

    console.log(problems.length === 0 ? '\n✅ No problems found.' : `\n❌ ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Simulation crashed:', err);
    process.exit(1);
});
