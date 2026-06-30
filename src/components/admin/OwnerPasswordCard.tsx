"use client";

import { useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

/**
 * Owner password change (#760) — a small client island on `/owner`. POSTs the
 * existing `POST /api/auth?action=change-password`, which for the env-only owner
 * (synthetic `__owner__` principal) rotates the hash in the `owner-auth.json`
 * blob — so the owner can change their sign-in password from the console, no env
 * edit or redeploy. Verifies the CURRENT password server-side; min 8 chars.
 */

type State = "idle" | "saving" | "done" | "error";

export function OwnerPasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "saving") return;
    if (next.length < 8) {
      setState("error");
      setMsg("New password must be at least 8 characters.");
      return;
    }
    setState("saving");
    setMsg(null);
    try {
      const res = await fetch("/api/auth?action=change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentSecret: current, newSecret: next }),
      });
      const data: { error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMsg(data.error || "Couldn't change the password.");
        return;
      }
      setState("done");
      setMsg("Password changed. Use it next time you sign in.");
      setCurrent("");
      setNext("");
    } catch {
      setState("error");
      setMsg("Couldn't reach the server. Try again.");
    }
  }

  const inputClass =
    "mt-1 w-full rounded-card border border-border bg-surface-raised px-3 py-2 text-sm text-text";

  return (
    <Card>
      <CardTitle>Owner password</CardTitle>
      <CardDescription className="mt-1">
        Change your owner sign-in password. Takes effect immediately — no redeploy.
      </CardDescription>
      <form onSubmit={submit} className="mt-4 max-w-sm space-y-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-text-muted">Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            data-testid="owner-pw-current"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-text-muted">New password (min 8)</span>
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            data-testid="owner-pw-new"
            className={inputClass}
          />
        </label>
        {msg ? (
          <p
            role={state === "error" ? "alert" : "status"}
            className={cn("text-sm", state === "error" ? "text-state-danger" : "text-text-muted")}
          >
            {msg}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={state === "saving" || !current || !next}
          data-testid="owner-pw-submit"
          className="rounded-card bg-brand-navy px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {state === "saving" ? "Changing…" : "Change password"}
        </button>
      </form>
    </Card>
  );
}
