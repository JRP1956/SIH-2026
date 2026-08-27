import type { FindingOut } from "@/lib/api";
import OrphanedFilesTable from "./OrphanedFilesTable";
import TeamRules from "./TeamRules";

export default function TeamInsights({ findings, repoKey }: { findings: FindingOut[], repoKey: string }) {
  const tribalFindings = findings.filter(f => f.category === "tribal");
  
  return (
    <div className="flex flex-col gap-10 animate-fade-in">
      {/* Orphaned Code Section */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-text-primary">Tribal Knowledge Graph</h2>
          <p className="text-[14px] text-text-secondary">
            Analyzes Git history and GitHub App data to identify orphaned code and bus factor risks.
          </p>
        </div>
        
        <div className="flex flex-col gap-4">
          <h3 className="text-[15px] font-medium text-text-primary">Orphaned Files</h3>
          <OrphanedFilesTable findings={tribalFindings} />
        </div>
      </div>
      
      {/* Team Rules Section */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1 border-t border-border-subtle pt-8">
          <h2 className="text-lg font-semibold text-text-primary">Unwritten Team Rules</h2>
          <p className="text-[14px] text-text-secondary">
            Extracted from recent PR code reviews in {repoKey}.
          </p>
        </div>
        
        <div className="flex flex-col gap-4">
          <TeamRules repoKey={repoKey} />
        </div>
      </div>
    </div>
  );
}
