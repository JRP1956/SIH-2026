"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import ScanOverview from "@/components/scans/ScanOverview";
import ScanConsole from "@/components/scans/ScanConsole";
import FindingsList from "@/components/scans/FindingsList";
import RiskDistribution from "@/components/scans/RiskDistribution";
import Alert from "@/components/ui/Alert";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { ButtonLink } from "@/components/ui/Button";
import { ScanPageSkeleton } from "@/components/ui/Skeleton";
import TeamInsights from "@/components/scans/TeamInsights";
import { ApiError, getScan, listScans, me, type ScanReport, type ScanSummary, type User } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export default function ScanPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const scanId = Number(id);
  const [user, setUser] = useState<User | null>(null);
  const [scan, setScan] = useState<ScanReport | null>(null);
  const [history, setHistory] = useState<ScanSummary[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"security" | "team">("security");

  useEffect(() => {
    me()
      .then((u) => setUser(u))
      .catch(() => router.push("/login"));
  }, [router]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const report = await getScan(scanId);
        if (!active) return;
        setScan(report);
        setRefreshError(null);
        if (report.status === "done" || report.status === "failed") {
          setHistory((await listScans(report.repo_key)).reverse());
          return;
        }
        timer = setTimeout(poll, 3000);
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push("/login");
          return;
        }
        setRefreshError(err instanceof Error ? err.message : "Could not load the scan");
        timer = setTimeout(poll, 3000);
      }
    }

    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [scanId, router]);

  if (!scan) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
          {refreshError ? (
            <Alert variant="warning">
              Lost contact with the server: {refreshError}. Retrying…
            </Alert>
          ) : (
            <ScanPageSkeleton />
          )}
        </div>
      </div>
    );
  }

  const trend = history
    .filter((s) => s.security_score !== null)
    .map((s) => s.security_score as number);

  const isActive = scan.status === "pending" || scan.status === "running";
  const done = scan.status === "done";

  return (
    <AppShell
      email={user?.email ?? null}
      user={user}
      variant="scan"
      actions={
        <ButtonLink href="/#new-scan" variant="secondary" size="sm">
          New analysis
        </ButtonLink>
      }
    >
      <div className="flex flex-col gap-8 animate-fade-in">
        {refreshError && (
          <Alert variant="warning">
            Lost contact with the server: {refreshError}. Retrying…
          </Alert>
        )}

        <ScanOverview scan={scan} trend={trend.length > 1 ? trend : undefined} />

        {isActive && <ScanConsole scan={scan} />}

        {scan.status === "failed" && (
          <Alert variant="error" title="Scan failed">
            {scan.error ?? "An unknown error occurred during analysis. Check repository access and try again."}
          </Alert>
        )}

        {done && scan.error && (
          <Alert variant="warning" title="Incomplete scan">
            {scan.error}. Findings from that tool are missing from this report;
            absence of results does not mean absence of issues.
          </Alert>
        )}

        {done && !scan.ai_available && (
          <Alert variant="info">
            AI explanations unavailable for this scan — findings below are raw scanner output.
          </Alert>
        )}

        {done && (
          <div className="flex flex-col gap-6">
            <SegmentedControl
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: "security", label: "Security & Debt" },
                { value: "team", label: "Team Insights" }
              ]}
            />
            
            {activeTab === "security" ? (
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
                <FindingsList findings={scan.findings} aiAvailable={scan.ai_available} />
                <aside className="flex flex-col gap-6">
                  {scan.findings.length > 0 && (
                    <RiskDistribution findings={scan.findings} />
                  )}
                  <ScanMetadata scan={scan} />
                </aside>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
                <TeamInsights findings={scan.findings} repoKey={scan.repo_key} />
                <aside className="flex flex-col gap-6">
                  <ScanMetadata scan={scan} />
                </aside>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ScanMetadata({ scan }: { scan: ScanReport }) {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Scan ID", value: <span className="font-mono tabular-nums">#{scan.id}</span> },
    { label: "Mode", value: <span className="font-mono uppercase">{scan.mode}</span> },
    { label: "Status", value: <span className="font-mono capitalize">{scan.status}</span> },
    {
      label: "Created",
      value: <time dateTime={scan.created_at} className="font-mono">{formatDateTime(scan.created_at)}</time>,
    },
    {
      label: "AI explanations",
      value: (
        <span className={`font-mono ${scan.ai_available ? "text-status-success" : "text-text-muted"}`}>
          {scan.ai_available ? "available" : "unavailable"}
        </span>
      ),
    },
  ];

  return (
    <div className="border border-border bg-white">
      <div className="border-b border-border-subtle px-4 py-2.5">
        <h3 className="text-[13px] font-semibold text-text-primary">Scan metadata</h3>
      </div>
      <dl className="flex flex-col divide-y divide-border-subtle">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[110px_1fr] gap-3 px-4 py-2.5">
            <dt className="text-[12px] text-text-muted">{row.label}</dt>
            <dd className="min-w-0 text-[12px] text-text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
