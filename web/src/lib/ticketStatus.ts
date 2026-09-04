// Tickets use a different (capitalized) status vocabulary than call_logs —
// kept separate from StatusPill's map rather than forcing a case-insensitive
// lookup there, since the two vocabularies aren't actually the same concept.
export const TICKET_STATUS_COLORS: Record<string, string> = {
    Open: 'var(--danger)',
    'Follow-up needed': 'var(--warning)',
    Escalated: 'var(--warning)',
    Resolved: 'var(--brand)',
    'No resolution': 'var(--status-neutral)'
};

export const TICKET_STATUSES = ['Open', 'Resolved', 'Escalated', 'Follow-up needed', 'No resolution'];
export const TICKET_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

export const TICKET_PRIORITY_COLORS: Record<string, string> = {
    Low: 'var(--status-neutral)',
    Medium: 'var(--brand-bright)',
    High: 'var(--warning)',
    Urgent: 'var(--danger)'
};
