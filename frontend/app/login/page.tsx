"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import AuthLayout, { AuthDivider, AuthLink, GitHubAuthButton } from "@/components/layout/AuthLayout";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import { login } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Access your repository security workspace."
      footer={
        <>
          No account? <AuthLink href="/signup">Create one</AuthLink>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
        <Input
          label="Password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        {error && <Alert variant="error">{error}</Alert>}
        <Button type="submit" disabled={busy} loading={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <AuthDivider />

      <GitHubAuthButton label="Continue with GitHub" />
    </AuthLayout>
  );
}
