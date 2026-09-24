import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useToast } from '../lib/toast';
import Pagination from '../components/Pagination';

type WalletRow = {
    balance_cents: number;
    inbound_rate_micros_per_second: number;
    outbound_rate_micros_per_second: number;
    low_balance_threshold_cents: number;
};

type Transaction = {
    id: number;
    type: 'topup' | 'usage' | 'reversal';
    amount_cents: number;
    reference: string;
    balance_after_cents: number;
    description: string | null;
    created_by: string | null;
    created_at: string;
    direction: 'inbound' | 'outbound' | null;
};

type DaySummary = {
    day: string; // 'YYYY-MM-DD', Nairobi calendar day (see migration 029)
    transaction_count: number;
    topup_cents: number;
    inbound_usage_cents: number;
    outbound_usage_cents: number;
    reversal_cents: number;
    net_change_cents: number;
    ending_balance_cents: number;
};

const DAY_PAGE_SIZE = 14;
const TX_PAGE_SIZE = 25;

function formatDay(day: string) {
    return new Date(`${day}T00:00:00+03:00`).toLocaleDateString('en-KE', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
}

// cents -> "KES 12.34" — every amount in this page passes through here, so
// there's exactly one place that knows the balance is stored in cents.
function formatKes(cents: number) {
    return `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ConfigPanel({ wallet }: { wallet: WalletRow }) {
    const queryClient = useQueryClient();
    const showToast = useToast();

    // Edited as whole KES/cents in the UI, converted to the stored units
    // only on save — nobody wants to type "50000" to mean KES 0.50/sec.
    const [inboundKes, setInboundKes] = useState(String(wallet.inbound_rate_micros_per_second / 1_000_000));
    const [outboundKes, setOutboundKes] = useState(String(wallet.outbound_rate_micros_per_second / 1_000_000));
    const [thresholdKes, setThresholdKes] = useState(String(wallet.low_balance_threshold_cents / 100));

    useEffect(() => {
        setInboundKes(String(wallet.inbound_rate_micros_per_second / 1_000_000));
        setOutboundKes(String(wallet.outbound_rate_micros_per_second / 1_000_000));
        setThresholdKes(String(wallet.low_balance_threshold_cents / 100));
    }, [wallet.inbound_rate_micros_per_second, wallet.outbound_rate_micros_per_second, wallet.low_balance_threshold_cents]);

    const save = useMutation({
        mutationFn: () =>
            apiFetch('/api/wallet/config', {
                method: 'PATCH',
                body: JSON.stringify({
                    inbound_rate_micros_per_second: Math.round(Number(inboundKes) * 1_000_000),
                    outbound_rate_micros_per_second: Math.round(Number(outboundKes) * 1_000_000),
                    low_balance_threshold_cents: Math.round(Number(thresholdKes) * 100)
                })
            }),
        onSuccess: () => {
            showToast('Wallet settings saved');
            queryClient.invalidateQueries({ queryKey: ['wallet'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const inboundValid = inboundKes !== '' && Number.isFinite(Number(inboundKes)) && Number(inboundKes) >= 0;
    const outboundValid = outboundKes !== '' && Number.isFinite(Number(outboundKes)) && Number(outboundKes) >= 0;
    const thresholdValid = thresholdKes !== '' && Number.isFinite(Number(thresholdKes)) && Number(thresholdKes) >= 0;

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>Billing settings</h3>
                <p className="hint">
                    Charged per second of connected call time, settled when each call ends. Inbound and outbound are
                    billed separately — Africa's Talking charges very differently by direction.
                </p>
            </div>
            <div className="forwarding-add-row wallet-config-row">
                <label>
                    Inbound rate (KES/sec)
                    <input type="number" min="0" step="0.0001" value={inboundKes} onChange={e => setInboundKes(e.target.value)} />
                </label>
                <label>
                    Outbound rate (KES/sec)
                    <input type="number" min="0" step="0.0001" value={outboundKes} onChange={e => setOutboundKes(e.target.value)} />
                </label>
                <label>
                    Low-balance alert threshold (KES)
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={thresholdKes}
                        onChange={e => setThresholdKes(e.target.value)}
                    />
                </label>
                <button
                    className="btn btn-primary"
                    disabled={!inboundValid || !outboundValid || !thresholdValid || save.isPending}
                    onClick={() => save.mutate()}
                >
                    Save
                </button>
            </div>
        </div>
    );
}

function TopUpPanel() {
    const queryClient = useQueryClient();
    const showToast = useToast();
    const [amountKes, setAmountKes] = useState('');
    const [description, setDescription] = useState('');

    const topUp = useMutation({
        mutationFn: () =>
            apiFetch('/api/wallet/topup', {
                method: 'POST',
                body: JSON.stringify({ amount_cents: Math.round(Number(amountKes) * 100), description: description.trim() || undefined })
            }),
        onSuccess: () => {
            showToast('Top-up recorded');
            setAmountKes('');
            setDescription('');
            queryClient.invalidateQueries({ queryKey: ['wallet'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const amountValid = amountKes !== '' && Number.isFinite(Number(amountKes)) && Number(amountKes) > 0;

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>Record a top-up</h3>
                <p className="hint">For recording money already paid to Africa's Talking — this doesn't move real money itself.</p>
            </div>
            <div className="forwarding-add-row wallet-topup-row">
                <label>
                    Amount (KES)
                    <input type="number" min="0" step="0.01" value={amountKes} onChange={e => setAmountKes(e.target.value)} />
                </label>
                <label>
                    Note (optional)
                    <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. AT top-up 2026-09" />
                </label>
                <button className="btn btn-primary" disabled={!amountValid || topUp.isPending} onClick={() => topUp.mutate()}>
                    Add funds
                </button>
            </div>
        </div>
    );
}

function TransactionRow({ tx }: { tx: Transaction }) {
    const sign = tx.amount_cents > 0 ? '+' : '';
    return (
        <tr>
            <td>{new Date(tx.created_at).toLocaleString()}</td>
            <td>{tx.type}</td>
            <td>{tx.direction ?? '—'}</td>
            <td style={tx.amount_cents < 0 ? { color: 'var(--danger)' } : undefined}>
                {sign}
                {formatKes(tx.amount_cents)}
            </td>
            <td>{formatKes(tx.balance_after_cents)}</td>
            <td>{tx.description || tx.reference}</td>
            <td>{tx.created_by || '—'}</td>
        </tr>
    );
}

// The individual transactions for one day, fetched only once a supervisor
// actually asks to see them (GET /api/wallet?day=...) — the default history
// view is the day-summary row this expands out of.
function DayTransactions({ day }: { day: string }) {
    const [page, setPage] = useState(1);

    const { data, isLoading, isError } = useQuery({
        queryKey: ['wallet-day', day, page],
        queryFn: () => apiFetch(`/api/wallet?day=${day}&page=${page}&pageSize=${TX_PAGE_SIZE}`)
    });

    const transactions: Transaction[] = data?.transactions ?? [];
    const total: number = data?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / TX_PAGE_SIZE));

    return (
        <div style={{ padding: 'var(--space-16) var(--space-20)', background: 'var(--page-bg)' }}>
            {isLoading && <p className="hint">Loading…</p>}
            {isError && <p className="error">Couldn't load transactions for this day.</p>}
            {!isLoading && !isError && (
                <>
                    <div className="table-scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>When</th>
                                    <th>Type</th>
                                    <th>Direction</th>
                                    <th>Amount</th>
                                    <th>Balance after</th>
                                    <th>Description</th>
                                    <th>By</th>
                                </tr>
                            </thead>
                            <tbody>
                                {transactions.map(tx => <TransactionRow key={tx.id} tx={tx} />)}
                            </tbody>
                        </table>
                    </div>
                    <Pagination page={page} totalPages={totalPages} onPageChange={setPage} total={total} pageSize={TX_PAGE_SIZE} />
                </>
            )}
        </div>
    );
}

function DayRow({ day, expanded, onToggle }: { day: DaySummary; expanded: boolean; onToggle: () => void }) {
    return (
        <>
            <tr>
                <td>{formatDay(day.day)}</td>
                <td>{day.transaction_count}</td>
                <td>{day.topup_cents ? formatKes(day.topup_cents) : '—'}</td>
                <td>{day.inbound_usage_cents ? formatKes(day.inbound_usage_cents) : '—'}</td>
                <td>{day.outbound_usage_cents ? formatKes(day.outbound_usage_cents) : '—'}</td>
                <td>{day.reversal_cents ? formatKes(day.reversal_cents) : '—'}</td>
                <td style={day.net_change_cents < 0 ? { color: 'var(--danger)' } : undefined}>
                    {day.net_change_cents > 0 ? '+' : ''}
                    {formatKes(day.net_change_cents)}
                </td>
                <td>{formatKes(day.ending_balance_cents)}</td>
                <td>
                    <button className="btn btn-link" onClick={onToggle}>
                        {expanded ? 'Hide' : 'See transactions'}
                    </button>
                </td>
            </tr>
            {expanded && (
                <tr>
                    <td colSpan={9} style={{ padding: 0 }}>
                        <DayTransactions day={day.day} />
                    </td>
                </tr>
            )}
        </>
    );
}

export default function Wallet() {
    const [page, setPage] = useState(1);
    // Only one day open at a time — simpler than tracking a set, and
    // there's little reason to compare two days' individual transactions
    // side by side.
    const [expandedDay, setExpandedDay] = useState<string | null>(null);

    const { data, isLoading, isError } = useQuery({
        queryKey: ['wallet', page],
        queryFn: () => apiFetch(`/api/wallet?page=${page}&pageSize=${DAY_PAGE_SIZE}`)
    });

    const wallet: WalletRow | null = data?.wallet ?? null;
    const days: DaySummary[] = data?.days ?? [];
    const totalDays: number = data?.totalDays ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalDays / DAY_PAGE_SIZE));

    if (isLoading) return <div className="page-loading">Loading…</div>;
    if (isError || !wallet) return <div className="panel"><p className="empty">Failed to load wallet.</p></div>;

    const isLow = wallet.balance_cents <= wallet.low_balance_threshold_cents;

    return (
        <div className="page-medium">
            <div className="panel panel-header">
                <div>
                    <h3 style={{ marginBottom: 2 }}>Wallet balance</h3>
                    <p className="hint" style={{ marginBottom: 0 }}>Chumz's own prepaid call-cost balance.</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '1.75rem', fontWeight: 600 }}>{formatKes(wallet.balance_cents)}</div>
                    {isLow && <span className="hint" style={{ color: 'var(--danger)' }}>Below low-balance threshold</span>}
                </div>
            </div>

            <TopUpPanel />
            <ConfigPanel wallet={wallet} />

            <div className="panel">
                <div className="panel-header">
                    <h3>Transaction history</h3>
                    <p className="hint">One row per day — open a day to see its individual transactions.</p>
                </div>
                <div className="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>Day</th>
                                <th>Transactions</th>
                                <th>Topped up</th>
                                <th>Inbound cost</th>
                                <th>Outbound cost</th>
                                <th>Reversals</th>
                                <th>Net change</th>
                                <th>Balance (end of day)</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {days.length === 0 && (
                                <tr><td colSpan={9} className="empty">No transactions yet</td></tr>
                            )}
                            {days.map(d => (
                                <DayRow
                                    key={d.day}
                                    day={d}
                                    expanded={expandedDay === d.day}
                                    onToggle={() => setExpandedDay(current => (current === d.day ? null : d.day))}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
                <Pagination page={page} totalPages={totalPages} onPageChange={setPage} total={totalDays} pageSize={DAY_PAGE_SIZE} />
            </div>
        </div>
    );
}
