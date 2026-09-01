import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Trash2, Users } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useSoftphone } from '../lib/softphone';
import { useToast } from '../lib/toast';
import { formatPhone, isValidPhone } from '../lib/phoneFormat';
import ConfirmDialog from '../components/ConfirmDialog';

type Contact = { id: number; name: string; phone: string };
type TeamAgent = { id: number; name: string; status: string };

const STATUS_LABEL: Record<string, string> = {
    available: 'Available',
    on_call: 'On a call',
    ringing: 'Ringing',
    break: 'On break',
    offline: 'Offline'
};

function initials(name: string) {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function Contacts() {
    const queryClient = useQueryClient();
    const showToast = useToast();
    const { registrationState, activeCall, outgoingCall, incomingCall, placeCall, placeInternalCall } = useSoftphone();

    const busy = !!(activeCall || outgoingCall || incomingCall);

    async function callNumber(phone: string) {
        if (registrationState !== 'registered') {
            showToast('Softphone is not registered yet — check your connection', 'error');
            return;
        }
        if (busy) {
            showToast('Finish or end the current call first', 'error');
            return;
        }
        try {
            await placeCall(phone);
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Call failed', 'error');
        }
    }

    async function callAgent(agent: TeamAgent) {
        if (registrationState !== 'registered') {
            showToast('Softphone is not registered yet — check your connection', 'error');
            return;
        }
        if (busy) {
            showToast('Finish or end the current call first', 'error');
            return;
        }
        try {
            await placeInternalCall(agent.id, agent.name);
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Call failed', 'error');
        }
    }

    // ── My Contacts ──
    const { data: contactsData, isLoading: contactsLoading } = useQuery({
        queryKey: ['contacts'],
        queryFn: () => apiFetch('/api/contacts')
    });
    const contacts: Contact[] = contactsData?.contacts ?? [];

    const [formOpen, setFormOpen] = useState(false);
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [formError, setFormError] = useState('');
    const [pendingDelete, setPendingDelete] = useState<Contact | null>(null);

    const addContact = useMutation({
        mutationFn: () => apiFetch('/api/contacts', { method: 'POST', body: JSON.stringify({ name: name.trim(), phone: `+${formatPhone(phone)}` }) }),
        onSuccess: () => {
            showToast('Contact saved');
            setFormOpen(false);
            setName('');
            setPhone('');
            queryClient.invalidateQueries({ queryKey: ['contacts'] });
        },
        onError: (err: unknown) => setFormError(err instanceof Error ? err.message : 'Something went wrong')
    });

    const deleteContact = useMutation({
        mutationFn: (id: number) => apiFetch(`/api/contacts/${id}`, { method: 'DELETE' }),
        onSuccess: () => {
            showToast('Contact removed');
            queryClient.invalidateQueries({ queryKey: ['contacts'] });
        },
        onError: () => showToast('Failed to remove contact', 'error'),
        onSettled: () => setPendingDelete(null)
    });

    function submitContact() {
        if (!name.trim()) {
            setFormError('Enter a name');
            return;
        }
        if (!isValidPhone(formatPhone(phone))) {
            setFormError('Enter a valid Kenyan number (e.g. 0712345678 or +254712345678)');
            return;
        }
        setFormError('');
        addContact.mutate();
    }

    // ── Team (agent-to-agent calling) ──
    const { data: teamData, isLoading: teamLoading } = useQuery({
        queryKey: ['agents-directory'],
        queryFn: () => apiFetch('/api/agents/assignable'),
        refetchInterval: 10000
    });
    const team: TeamAgent[] = teamData?.agents ?? [];

    return (
        <div>
            <div className="panel">
                <div className="panel-header">
                    <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Phone size={18} /> My Contacts
                    </h3>
                    <button className="btn btn-primary" onClick={() => { setFormOpen(true); setFormError(''); }}>
                        + Add Contact
                    </button>
                </div>
                <p className="hint">Numbers you call often — saved just for you, ready for one-tap dialing.</p>

                {contacts.length === 0 && !contactsLoading && (
                    <p className="empty">No contacts yet — add your first one.</p>
                )}

                <div className="agent-grid">
                    {contacts.map(contact => (
                        <div className="agent-card" key={contact.id}>
                            <div className="agent-card-header">
                                <div className="agent-avatar">{initials(contact.name)}</div>
                                <div style={{ minWidth: 0 }}>
                                    <div className="agent-card-name">{contact.name}</div>
                                    <div className="agent-card-meta">{contact.phone}</div>
                                </div>
                            </div>
                            <div className="agent-card-actions">
                                <button className="btn btn-link" onClick={() => callNumber(contact.phone)} disabled={busy}>
                                    <Phone size={14} /> Call
                                </button>
                                <button className="btn btn-link btn-link-danger" onClick={() => setPendingDelete(contact)}>
                                    <Trash2 size={14} /> Remove
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="panel" style={{ marginTop: 20 }}>
                <div className="panel-header">
                    <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Users size={18} /> Team
                    </h3>
                </div>
                <p className="hint">Call a teammate directly — rings their softphone, no external line involved.</p>

                {team.length === 0 && !teamLoading && <p className="empty">No other agents yet.</p>}

                <div className="agent-grid">
                    {team.map(agent => {
                        const callable = agent.status === 'available';
                        return (
                            <div className="agent-card" key={agent.id}>
                                <div className="agent-card-header">
                                    <div className="agent-avatar">{initials(agent.name)}</div>
                                    <div style={{ minWidth: 0 }}>
                                        <div className="agent-card-name">{agent.name}</div>
                                        <div className="agent-card-meta">{STATUS_LABEL[agent.status] ?? agent.status}</div>
                                    </div>
                                </div>
                                <div className="agent-card-actions">
                                    <button
                                        className="btn btn-link"
                                        onClick={() => callAgent(agent)}
                                        disabled={busy || !callable}
                                        title={callable ? undefined : "They're not available to call right now"}
                                    >
                                        <Phone size={14} /> Call
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {formOpen && (
                <div className="modal-overlay" onClick={() => setFormOpen(false)}>
                    <div className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                        <h3>Add Contact</h3>

                        <label>
                            Name
                            <input value={name} onChange={e => setName(e.target.value)} autoFocus />
                        </label>
                        <label>
                            Phone
                            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="0712345678" />
                        </label>
                        <p className="hint" style={{ marginTop: -10 }}>Either 0712345678 or +254712345678 works.</p>

                        {formError && <p className="error">{formError}</p>}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={submitContact} disabled={addContact.isPending}>
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={!!pendingDelete}
                title="Remove contact"
                message={`Remove ${pendingDelete?.name} from your contacts?`}
                confirmLabel="Remove"
                danger
                confirmDisabled={deleteContact.isPending}
                onConfirm={() => pendingDelete && deleteContact.mutate(pendingDelete.id)}
                onCancel={() => setPendingDelete(null)}
            />
        </div>
    );
}
