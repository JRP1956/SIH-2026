import type { FindingOut } from "@/lib/api";

export default function OrphanedFilesTable({ findings }: { findings: FindingOut[] }) {
  if (findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
        <div className="text-[13px] font-medium text-text-primary">No orphaned files detected</div>
        <p className="mt-1 max-w-[300px] text-[12px] text-text-secondary">
          All files in this repository have been modified by an active contributor within the last 6 months.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[6px] border border-border bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="px-4 py-3 font-medium text-text-primary">File</th>
              <th className="px-4 py-3 font-medium text-text-primary">Primary Author</th>
              <th className="px-4 py-3 font-medium text-text-primary">Ownership</th>
              <th className="px-4 py-3 font-medium text-text-primary">Last Commit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {findings.map((f, idx) => {
              const meta = f.metadata || {};
              const pct = meta.ownership_percentage 
                ? `${Math.round(meta.ownership_percentage * 100)}%` 
                : "Unknown";
              
              const date = meta.last_commit_at 
                ? new Date(meta.last_commit_at).toLocaleDateString()
                : "Unknown";

              return (
                <tr key={idx} className="group hover:bg-surface-1">
                  <td className="px-4 py-3">
                    <span className="font-mono text-text-primary break-all">{f.file}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="text-text-primary font-medium">{meta.primary_author_name}</span>
                      <span className="text-[12px] text-text-muted">{meta.primary_author_email}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{pct}</td>
                  <td className="px-4 py-3 text-text-secondary">{date}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
