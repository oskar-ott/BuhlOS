"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { Button } from "./Button";
import { cn } from "@/lib/cn";

interface Props {
  label?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

/**
 * Re-runs the current route's server components via router.refresh() so a
 * server-side fetch that failed (bad signal, an API hiccup) can be retried
 * in place — no full reload, no lost scroll position. Used in the amber
 * "couldn't load" cards across Phil and the admin surface so a field
 * worker on patchy reception (or an owner on a flaky connection) has a
 * one-tap recovery instead of a dead end.
 */
export function RefreshButton({
  label = "Try again",
  className,
  size = "sm",
  variant = "secondary",
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RotateCw aria-hidden="true" className={cn("h-4 w-4", pending ? "animate-spin" : "")} />
      {pending ? "Refreshing…" : label}
    </Button>
  );
}
