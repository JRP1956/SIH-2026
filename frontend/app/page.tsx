"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import ScanForm from "@/components/dashboard/ScanForm";
import ScanHistoryTable from "@/components/dashboard/ScanHistoryTable";
import SystemStatusStrip from "@/components/dashboard/SystemStatusStrip";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { createScan, listScans, me, type ScanSummary, type User } from "@/lib/api";
import { displayName, timeGreeting } from "@/lib/user";

/** One-line summary of what the workspace is currently doing. */
function workspaceSubtitle(scans: ScanSummary[]): string {
  const active = scans.filter(
    (s) => s.status === "running" || s.status === "pending"
  ).length;
  const repos = new Set(scans.map((s) => s.repo_key)).size;
  const analysisWord = active === 1 ? "analysis" : "analyses";
  const repoWord = repos === 1 ? "repository" : "repositories";

  if (active > 0 && repos > 0) {
    return `You have ${active} ${analysisWord} in progress across ${repos} ${repoWord} in your workspace.`;
  }
  if (repos > 0) {
    return `Your security workspace is monitoring ${repos} ${repoWord} for vulnerabilities and code-health issues.`;
  }
  return "Your security workspace is actively monitoring repository analysis and vulnerabilities.";
}

function DashboardGreeting({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <header className="flex flex-col gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-status-success animate-pulse-dot"
        />
        Security workspace
      </span>
      <h1 className="text-[26px] font-semibold tracking-tight text-text-primary sm:text-[28px]">
        {timeGreeting()}, {name}
      </h1>
      <p className="max-w-2xl text-[14px] text-text-secondary">{subtitle}</p>
    </header>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setScans(await listScans());
      setRefreshError(null);
    } catch (err) {
      setRefreshError(
        err instanceof Error ? err.message : "Could not refresh scans"
      );
    } finally {
      setInitialLoad(false);
    }
  }, []);

  useEffect(() => {
    me()
      .then((u) => {
        setUser(u);
        setAuthChecked(true);
      })
      .then(refresh)
      .catch(() => router.push("/login"));
  }, [refresh, router]);

  useEffect(() => {
    if (!scans.some((s) => s.status === "pending" || s.status === "running")) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [scans, refresh]);

  async function handleSubmit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const created = await createScan(form);
      router.push(`/scans/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the scan");
    } finally {
      setBusy(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
          <DashboardSkeleton />
        </div>
      </div>
    );
  }

  return (
    <AppShell email={user?.email ?? null} user={user} variant="dashboard">
      <div className="flex flex-col gap-10 animate-fade-in">
        <DashboardGreeting name={displayName(user)} subtitle={workspaceSubtitle(scans)} />

        <SystemStatusStrip scans={scans} />

        <ScanForm onSubmit={handleSubmit} busy={busy} error={error} />

        <ScanHistoryTable
          scans={scans}
          loading={initialLoad && scans.length === 0}
          refreshError={refreshError}
        />
      </div>
    </AppShell>
  );
}
