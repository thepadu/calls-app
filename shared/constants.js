// Shared between ari-app and calls-app — two separate npm packages, but
// siblings in this one repo, so a plain relative require() here keeps them
// in sync without needing workspace tooling. Both used to declare this
// constant independently, kept aligned only by a comment.
module.exports = {
    // An agent's last_seen_at heartbeat older than this is treated as a
    // dead tab: ari-app's reconcileGhostAgents flips them to offline,
    // calls-app's available-count badge pre-filters them out.
    GHOST_AGENT_STALE_MS: 90 * 1000
};
