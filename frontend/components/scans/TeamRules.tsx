"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type CandidateRuleOut = {
  id: number;
  repo_key: string;
  rule_text: string;
  status: string;
  created_at: string;
};

export default function TeamRules({ repoKey }: { repoKey: string }) {
  const [rules, setRules] = useState<CandidateRuleOut[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<CandidateRuleOut[]>(`/scans/rules?repo_key=${encodeURIComponent(repoKey)}`)
      .then((data) => {
        setRules(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch rules:", err);
        setLoading(false);
      });
  }, [repoKey]);

  const handleUpdate = async (id: number, status: string) => {
    try {
      const updated = await api<CandidateRuleOut>(`/scans/rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setRules((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch (err) {
      console.error("Failed to update rule:", err);
    }
  };

  if (loading) {
    return <div className="text-[14px] text-text-secondary animate-pulse">Loading team rules...</div>;
  }

  if (rules.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-background-alt border border-border-subtle rounded-xl text-center">
        <div className="font-medium text-[14px] text-text-primary mb-1">No rules extracted yet</div>
        <div className="text-[13px] text-text-secondary">
          Install the GitHub App to automatically extract unwritten team rules from PR comments.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rules.map((rule) => (
        <div
          key={rule.id}
          className={`flex flex-col gap-3 p-4 rounded-xl border transition-colors ${
            rule.status === "accepted"
              ? "bg-emerald-500/10 border-emerald-500/20"
              : rule.status === "rejected"
              ? "bg-red-500/5 border-red-500/10 opacity-60"
              : "bg-background-alt border-border-subtle hover:border-border-hover"
          }`}
        >
          <div className="text-[14px] text-text-primary leading-relaxed whitespace-pre-wrap font-medium">
            "{rule.rule_text}"
          </div>
          <div className="flex items-center justify-between mt-1">
            <div className="text-[12px] text-text-secondary">
              Status: <span className="capitalize">{rule.status}</span>
            </div>
            {rule.status === "pending" && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleUpdate(rule.id, "rejected")}
                  className="px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-red-400 bg-background hover:bg-red-500/10 rounded-md transition-colors border border-border-subtle hover:border-red-500/30"
                >
                  Reject
                </button>
                <button
                  onClick={() => handleUpdate(rule.id, "accepted")}
                  className="px-3 py-1.5 text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors shadow-sm"
                >
                  Accept
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
