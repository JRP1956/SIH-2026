"use client";

import Link from "next/link";
import Logo from "@/components/layout/Logo";
import { githubLoginUrl } from "@/lib/api";

export default function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border bg-header-bg">
        <div className="mx-auto flex h-12 max-w-6xl items-center px-4 lg:px-8">
          <Logo />
        </div>
      </header>

      <main className="relative flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 surface-grid opacity-40"
        />
        <div className="relative w-full max-w-sm animate-fade-in">
          <div className="mb-8 flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
              VibeGuard
            </span>
            <h1 className="text-[22px] font-semibold tracking-tight text-text-primary">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[13px] text-text-secondary">{subtitle}</p>
            )}
          </div>

          <div className="border border-border bg-white p-6">{children}</div>

          {footer && (
            <p className="mt-4 text-center text-[13px] text-text-secondary">
              {footer}
            </p>
          )}

          <p className="mt-8 text-center font-mono text-[11px] text-text-muted">
            security analysis for modern codebases
          </p>
        </div>
      </main>
    </div>
  );
}

export function AuthDivider() {
  return (
    <div className="relative my-5 flex items-center">
      <div className="flex-1 border-t border-border-subtle" />
      <span className="px-3 text-[11px] font-medium uppercase tracking-wide text-text-muted">
        or
      </span>
      <div className="flex-1 border-t border-border-subtle" />
    </div>
  );
}

export function AuthLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-medium text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-sm"
    >
      {children}
    </Link>
  );
}

/** GitHub OAuth entry point, shared by the login and signup pages. */
export function GitHubAuthButton({ label }: { label: string }) {
  return (
    <a
      href={githubLoginUrl()}
      className="flex h-9 w-full items-center justify-center gap-2 rounded-[4px] border border-border bg-white text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
      </svg>
      {label}
    </a>
  );
}
