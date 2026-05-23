import type { ReactNode } from "react";
import { PhilHeader } from "./PhilHeader";
import { PhilTabBar } from "./PhilTabBar";

interface PhilShellProps {
  children: ReactNode;
  title: string;
}

/**
 * Mobile-first Phil shell.
 *
 * Phase A is parallel to the legacy public/phil.html — this new shell lives
 * at /v2/phil while the legacy surface keeps serving /phil. Cutover is
 * Phase B work, gated on the Phil hours pipeline being verified end-to-end.
 */
export function PhilShell({ children, title }: PhilShellProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface">
      <PhilHeader title={title} />
      <main className="flex-1 overflow-y-auto px-4 py-4">{children}</main>
      <PhilTabBar />
    </div>
  );
}
