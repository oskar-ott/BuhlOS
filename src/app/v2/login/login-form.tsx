"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { migrateLocalStorage } from "@/lib/storage/migrate-local-storage";
import { landingFor } from "@/lib/auth/landing";

interface LoginFormProps {
  next?: string;
}

/**
 * Client component that POSTs to the existing /api/auth?action=login endpoint.
 * The endpoint sets the buhl_session cookie; on success we hard-navigate so
 * the new cookie is observed by middleware on the next request.
 *
 * Body shape mirrors the legacy login form (public/login.html line 972):
 * `{ username, secret }`. The earlier Phase A draft sent
 * `{ identifier, password }` which api/auth.js rejected with 400
 * "username and secret required" — blocking preview verification. Fixed
 * here without touching api/*.js or the legacy login.
 *
 * Uses the SAME landingFor() implementation as src/middleware.ts (no second
 * source of truth — non-negotiable §"One canonical source per concept").
 */
export function LoginForm({ next }: LoginFormProps) {
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // One-time cleanup of deprecated "buhl-site-office-*" localStorage keys.
    migrateLocalStorage();
  }, []);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/auth?action=login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          // api/auth.js destructures { username, secret } — must match.
          body: JSON.stringify({ username: identifier, secret }),
          cache: "no-store",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `Sign-in failed (${res.status}).`);
          return;
        }
        const body = (await res.json()) as { user?: { role?: string } };
        const target = next && next.startsWith("/") ? next : landingFor(body.user?.role);
        // Hard navigation so the new session cookie is read by the middleware.
        window.location.assign(target);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error.");
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-card border border-border bg-surface-raised p-5 shadow-card"
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-text">Email or username</span>
        <input
          type="text"
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="h-10 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-text">Password or PIN</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="h-10 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-state-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-xs text-text-muted">
        Need the legacy login?{" "}
        <a href="/login" className="underline underline-offset-2">
          Use the original
        </a>
        .
      </p>
    </form>
  );
}
