import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useToast } from '../lib/toast';
import { useModalA11y } from '../lib/useModalA11y';
import { formatPhone, isValidPhone } from '../lib/phoneFormat';
import { Users } from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusDropdown from '../components/StatusDropdown';
import Pagination from '../components/Pagination';

const STATUS_OPTIONS = ['available', 'break', 'offline'];

const PAGE_SIZE = 20;

type Agent = {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    status: 'available' | 'on_call' | 'ringing' | 'break' | 'offline';
    role: 'agent' | 'supervisor';
    agent_sip_credentials: { sip_username: string; asterisk_synced_at: string | null } | null;
};

const EMPTY_FORM = { name: '', phone: '', email: '', role: 'agent' as Agent['role'] };

function initials(name: string) {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function Agents() {
    const queryClient = useQueryClient();
    const showToast = useToast();

    const [rosterPage, setRosterPage] = useState(1);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');

    // Debounced rather than Calls/Tickets' draft+Apply-button pattern — this
    // is a single live-search box, better served by "type and it just
    // updates" a moment later than an extra click, while still avoiding a
    // request fired on every keystroke.
    useEffect(() => {
        const timer = setTimeout(() => {
            setSearch(searchInput);
            setRosterPage(1);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const { data: agentsData, isLoading: agentsLoading, isError: agentsIsError } = useQuery({
        queryKey: ['agents', rosterPage, search],
        queryFn: () => apiFetch(`/api/agents?page=${rosterPage}&pageSize=${PAGE_SIZE}&q=${encodeURIComponent(search)}`)
    });

    const agents: Agent[] = agentsData?.agents ?? [];
    const rosterTotal: number = agentsData?.total ?? 0;
    const rosterTotalPages: number = agentsData?.totalPages ?? 1;

    const rosterStatusMessage = agentsIsError
        ? "Couldn't load agents."
        : agentsLoading
        ? 'Loading…'
        : agents.length === 0
        ? search
            ? `No agents match "${search}".`
            : 'No agents yet — add your first one.'
        : null;

    const [formOpen, setFormOpen] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [formError, setFormError] = useState('');
    const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

    function invalidate() {
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        queryClient.invalidateQueries({ queryKey: ['agents-available-count'] });
    }

    const saveAgent = useMutation({
        // The backend requires strict E.164 (+254712345678) — same
        // normalization the dialer already applies, so a supervisor can type
        // a number the way everyone actually types it (0712345678) instead
        // of hitting a server-side validation error for not typing "+254".
        mutationFn: () => {
            // Editing an agent with no phone on file (most real agents —
            // provisioned through the modern SIP flow, which doesn't need
            // one) shouldn't force one into existence just to save an
            // unrelated change like their name or role. `undefined` here
            // drops the key entirely (JSON.stringify skips it), which the
            // backend's PATCH handler already treats as "leave phone alone".
            const phoneEntered = form.phone.trim().length > 0;
            const body = { ...form, phone: phoneEntered ? `+${formatPhone(form.phone)}` : editingId ? undefined : '' };
            return editingId
                ? apiFetch(`/api/agents/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) })
                : apiFetch('/api/agents', { method: 'POST', body: JSON.stringify(body) });
        },
        onSuccess: () => {
            showToast(editingId ? 'Agent updated' : 'Agent added');
            setFormOpen(false);
            invalidate();
        },
        onError: (err: unknown) => setFormError(err instanceof Error ? err.message : 'Something went wrong')
    });

    function submitAgent() {
        // A phone number is only required when creating a new (legacy
        // phone-ring) agent, or when editing one and actually typing a
        // number in — not for every save of an agent who was provisioned
        // through the modern SIP flow and has never had one.
        const phoneEntered = form.phone.trim().length > 0;
        if ((!editingId || phoneEntered) && !isValidPhone(formatPhone(form.phone))) {
            setFormError('Enter a valid Kenyan number (e.g. 0712345678 or +254712345678)');
            return;
        }
        setFormError('');
        saveAgent.mutate();
    }

    const toggleStatus = useMutation({
        mutationFn: ({ id, status }: { id: number; status: Agent['status'] }) =>
            apiFetch(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
        onSuccess: invalidate,
        onError: () => showToast('Failed to update status', 'error')
    });

    const deleteAgent = useMutation({
        mutationFn: (id: number) => apiFetch(`/api/agents/${id}`, { method: 'DELETE' }),
        onSuccess: () => {
            showToast('Agent removed');
            invalidate();
        },
        onError: () => showToast('Failed to remove agent', 'error'),
        onSettled: () => setPendingDelete(null)
    });

    // Provisions a browser softphone end-to-end — generates credentials and
    // pushes them to the Asterisk VPS via ari-app's internal endpoint. Never
    // surfaces sip_password here; an agent fetches their own credentials
    // via GET /api/agents/me/sip-credentials once provisioned.
    const provisionSip = useMutation({
        mutationFn: (id: number) => apiFetch(`/api/agents/${id}/sip-credentials`, { method: 'POST' }),
        onSuccess: (data: { asteriskSynced: boolean }) => {
            showToast(data.asteriskSynced ? 'Softphone provisioned' : 'Credentials saved — Asterisk sync pending, retry below');
            invalidate();
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const syncSip = useMutation({
        mutationFn: (id: number) => apiFetch(`/api/agents/${id}/sip-credentials/sync`, { method: 'POST' }),
        onSuccess: (data: { asteriskSynced: boolean }) => {
            showToast(data.asteriskSynced ? 'Softphone synced' : 'Still not reachable — will need another retry');
            invalidate();
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    function errorMessage(err: unknown) {
        return err instanceof Error ? err.message : 'Something went wrong';
    }

    function openAddForm() {
        setEditingId(null);
        setForm(EMPTY_FORM);
        setFormError('');
        setFormOpen(true);
    }

    function openEditForm(agent: Agent) {
        setEditingId(agent.id);
        setForm({ name: agent.name, phone: agent.phone ?? '', email: agent.email ?? '', role: agent.role });
        setFormError('');
        setFormOpen(true);
    }

    const containerRef = useModalA11y(formOpen, () => setFormOpen(false));

    return (
        <div>
            <div className="panel">
                <div className="panel-header">
                    <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Users size={18} /> Team {rosterTotal > 0 && <span className="hint" style={{ fontWeight: 400 }}>({rosterTotal})</span>}</h3>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Link to="/analytics" className="btn-link">Performance →</Link>
                        <button className="btn btn-primary" onClick={openAddForm}>+ Add Agent</button>
                    </div>
                </div>
                <p className="hint">
                    Agents with a browser softphone just go <strong>available</strong> — waiting callers ring
                    their browser directly. A softphone is required to take calls — an agent without one
                    provisioned can't go available until a supervisor sets one up below.
                </p>

                <input
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    placeholder="Search by name or phone…"
                    style={{ marginBottom: 14 }}
                />

                {rosterStatusMessage && <p className="empty">{rosterStatusMessage}</p>}

                <div className="agent-grid">
                    {agents.map(agent => (
                        <div className="agent-card" key={agent.id}>
                            <div className="agent-card-header">
                                <div className="agent-avatar">{initials(agent.name)}</div>
                                <div style={{ minWidth: 0 }}>
                                    <div className="agent-card-name">{agent.name}</div>
                                    <div className="agent-card-meta">{agent.phone ?? 'No phone (softphone agent)'}</div>
                                    {agent.email && <div className="agent-card-meta">{agent.email}</div>}
                                </div>
                            </div>
                            <div className="agent-card-status">
                                {/* See setAgentStatus() in api.js for what "available" actually
                                    does — a direct flag flip for agents on a browser softphone,
                                    a real phone call for anyone not yet migrated. on_call/ringing
                                    are system-managed but still overridable here, so a supervisor
                                    can force a stuck agent back to any of the 3 real states. */}
                                <StatusDropdown
                                    value={agent.status}
                                    options={STATUS_OPTIONS}
                                    title={agent.status === 'ringing' ? 'Calling their phone now…' : undefined}
                                    onChange={status => toggleStatus.mutate({ id: agent.id, status: status as Agent['status'] })}
                                />
                                {agent.role === 'supervisor' && (
                                    <span className="status-pill" style={{ background: 'var(--brand-dark)', marginLeft: 6 }}>
                                        Supervisor
                                    </span>
                                )}
                            </div>
                            <div className="agent-card-actions">
                                <button className="btn btn-link" onClick={() => openEditForm(agent)}>Edit</button>
                                {!agent.agent_sip_credentials && (
                                    <button
                                        className="btn btn-link"
                                        onClick={() => provisionSip.mutate(agent.id)}
                                        disabled={provisionSip.isPending}
                                        title="Set up a browser softphone for this agent"
                                    >
                                        Add Softphone
                                    </button>
                                )}
                                {agent.agent_sip_credentials && !agent.agent_sip_credentials.asterisk_synced_at && (
                                    <button
                                        className="btn btn-link"
                                        onClick={() => syncSip.mutate(agent.id)}
                                        disabled={syncSip.isPending}
                                        title="Credentials saved but not yet confirmed live on Asterisk — retry the sync"
                                    >
                                        Sync pending — Retry
                                    </button>
                                )}
                                <button className="btn btn-link btn-link-danger" onClick={() => setPendingDelete(agent)}>
                                    Remove
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                <Pagination page={rosterPage} totalPages={rosterTotalPages} onPageChange={setRosterPage} />
            </div>

            {formOpen && (
                <div className="modal-overlay" onClick={() => setFormOpen(false)}>
                    <div ref={containerRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                        <h3>{editingId ? 'Edit Agent' : 'Add Agent'}</h3>

                        <label>
                            Name
                            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                        </label>
                        <label>
                            Phone
                            <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0712345678" />
                        </label>
                        <p className="hint" style={{ marginTop: -10 }}>Either 0712345678 or +254712345678 works.</p>
                        <label>
                            Email (optional — links their Google login)
                            <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="agent@chumz.io" />
                        </label>
                        <label>
                            Role
                            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Agent['role'] })}>
                                <option value="agent">Agent</option>
                                <option value="supervisor">Supervisor</option>
                            </select>
                        </label>

                        {formError && <p className="error">{formError}</p>}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={submitAgent} disabled={saveAgent.isPending}>
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={!!pendingDelete}
                title="Remove agent"
                message={`Remove ${pendingDelete?.name}? They'll no longer be dialed for support calls.`}
                confirmLabel="Remove"
                danger
                onConfirm={() => pendingDelete && deleteAgent.mutate(pendingDelete.id)}
                onCancel={() => setPendingDelete(null)}
            />
        </div>
    );
}
