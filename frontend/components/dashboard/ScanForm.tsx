"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import SegmentedControl from "@/components/ui/SegmentedControl";

type ScanFormProps = {
  onSubmit: (form: FormData) => Promise<void>;
  busy: boolean;
  error: string | null;
};

type SourceMode = "url" | "upload";

type ScanDraft = {
  mode: SourceMode;
  repoUrl: string;
  zip: File | null;
  baseRef: string;
  headRef: string;
};

/** The first thing wrong with the draft, or null when it is ready to submit. */
function validationMessage(draft: ScanDraft): string | null {
  if (draft.mode === "url" && !draft.repoUrl.trim()) {
    return "Enter a repository URL to analyze.";
  }
  if (draft.mode === "upload" && !draft.zip) {
    return "Select a ZIP archive to analyze.";
  }
  if (Boolean(draft.baseRef) !== Boolean(draft.headRef)) {
    return "Both base and head refs are required for diff scans.";
  }
  return null;
}

function buildScanForm(draft: ScanDraft): FormData {
  const form = new FormData();
  if (draft.mode === "url") {
    form.append("repo_url", draft.repoUrl);
  } else if (draft.zip) {
    form.append("zip_file", draft.zip);
  }
  if (draft.baseRef && draft.headRef) {
    form.append("base_ref", draft.baseRef);
    form.append("head_ref", draft.headRef);
  }
  return form;
}

export default function ScanForm({ onSubmit, busy, error }: ScanFormProps) {
  const [mode, setMode] = useState<SourceMode>("url");
  const [repoUrl, setRepoUrl] = useState("");
  const [zip, setZip] = useState<File | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const draft: ScanDraft = { mode, repoUrl, zip, baseRef, headRef };
    const problem = validationMessage(draft);
    setValidationError(problem);
    if (problem) {
      return;
    }
    await onSubmit(buildScanForm(draft));
  }

  const canSubmit =
    !busy &&
    ((mode === "url" && repoUrl.trim() !== "") ||
      (mode === "upload" && zip !== null));

  return (
    <section id="new-scan" aria-labelledby="new-scan-heading">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h2
            id="new-scan-heading"
            className="text-[17px] font-semibold tracking-tight text-text-primary"
          >
            Start an analysis
          </h2>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            Analyze a public repository or upload a source archive.
          </p>
        </div>
        <SegmentedControl<SourceMode>
          label="Analysis source"
          value={mode}
          onChange={setMode}
          disabled={busy}
          options={[
            { value: "url", label: "Repository URL" },
            { value: "upload", label: "Upload archive" },
          ]}
        />
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 border border-border bg-white p-5"
      >
        {mode === "url" ? (
          <Input
            label="Repository URL"
            type="url"
            placeholder="https://github.com/owner/repository"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            disabled={busy}
            monospace
          />
        ) : (
          <label
            htmlFor="zip-upload"
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              const file = e.dataTransfer.files?.[0];
              if (file && file.name.endsWith(".zip")) setZip(file);
            }}
            className={`flex cursor-pointer flex-col items-start gap-1 border border-dashed px-4 py-5 transition-colors focus-within:ring-1 focus-within:ring-focus-ring ${
              zip
                ? "border-accent bg-accent-subtle"
                : dragActive
                  ? "border-accent bg-accent-subtle"
                  : "border-border bg-surface-2/60 hover:border-border-strong hover:bg-surface-2"
            } ${busy ? "pointer-events-none opacity-55" : ""}`}
          >
            <input
              id="zip-upload"
              type="file"
              accept=".zip"
              className="sr-only"
              disabled={busy}
              onChange={(e) => setZip(e.target.files?.[0] ?? null)}
            />
            {zip ? (
              <>
                <span className="font-mono text-[13px] text-text-primary">
                  {zip.name}
                </span>
                <span className="font-mono text-[12px] text-text-muted">
                  {(zip.size / 1024 / 1024).toFixed(2)} MB · click or drop to
                  replace
                </span>
              </>
            ) : (
              <>
                <span className="text-[13px] font-medium text-text-primary">
                  Drop ZIP archive here
                </span>
                <span className="text-[12px] text-text-muted">
                  or <span className="text-accent underline decoration-accent/40 underline-offset-2">browse files</span> · .zip · max 50 MB
                </span>
              </>
            )}
          </label>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowDiff(!showDiff)}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-sm"
            aria-expanded={showDiff}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={`transition-transform ${showDiff ? "rotate-90" : ""}`}
              aria-hidden
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Advanced settings (diff refs)
          </button>
          {showDiff && (
            <div className="mt-3 grid gap-3 border-t border-border-subtle pt-3 sm:grid-cols-2">
              <Input
                label="Base ref"
                placeholder="main"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                disabled={busy}
                monospace
              />
              <Input
                label="Head ref"
                placeholder="feature/my-branch"
                value={headRef}
                onChange={(e) => setHeadRef(e.target.value)}
                disabled={busy}
                monospace
              />
            </div>
          )}
        </div>

        {(validationError || error) && (
          <Alert variant="error">{validationError ?? error}</Alert>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
          <p className="font-mono text-[11px] text-text-muted">
            Analysis runs asynchronously · results stream to a report page
          </p>
          <Button
            type="submit"
            disabled={!canSubmit}
            loading={busy}
            aria-label={busy ? "Starting analysis" : "Run security analysis"}
          >
            {busy ? "Starting…" : "Run security analysis"}
          </Button>
        </div>
      </form>
    </section>
  );
}
