type Props = { hours: { hour: number; count: number }[]; isLoading?: boolean; isError?: boolean };

export default function CallsByHourChart({ hours, isLoading, isError }: Props) {
    const max = Math.max(1, ...hours.map(h => h.count));
    const statusMessage = isError ? "Couldn't load this chart." : isLoading ? 'Loading…' : hours.length === 0 ? 'No calls logged today yet.' : null;

    return (
        <div className="panel">
            <h3>Calls by hour</h3>
            {statusMessage && <p className="empty">{statusMessage}</p>}
            {!statusMessage && (
                <div className="hour-chart">
                    {hours.map(h => (
                        <div className="hour-chart-bar-col" key={h.hour}>
                            <div className="hour-chart-bar" style={{ height: `${Math.round((h.count / max) * 100)}%` }} />
                            <div className="hour-chart-label">{h.hour % 12 === 0 ? 12 : h.hour % 12}{h.hour < 12 ? 'a' : 'p'}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
