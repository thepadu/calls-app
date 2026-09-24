type PaginationProps = {
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    total: number;
    pageSize: number;
};

// "X-Y of Z", not "Page X of Y" — Material's own data-table pagination
// guidance calls the plain page-count text out as worse than showing the
// real range/total, and every caller already has both numbers on hand.
// Shown whenever there's real data, even on a single page (also per that
// guidance) — only Previous/Next themselves need totalPages, already
// correctly disabled at each boundary below.
export default function Pagination({ page, totalPages, onPageChange, total, pageSize }: PaginationProps) {
    if (total <= 0) return null;

    const from = (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);

    return (
        <div className="pagination">
            <button className="btn btn-secondary" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
                Previous
            </button>
            <span className="pagination-status">
                {from}–{to} of {total}
            </span>
            <button className="btn btn-secondary" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
                Next
            </button>
        </div>
    );
}
