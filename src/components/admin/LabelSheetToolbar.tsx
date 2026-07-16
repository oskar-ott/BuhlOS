"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * The on-screen toolbar for the #303 QR label sheet — hidden when printing
 * (`.labels-toolbar` display:none in the print media query). Carries the print
 * trigger and the way back to the register.
 */
export function LabelSheetToolbar({ count }: { count: number }) {
  return (
    <div className="labels-toolbar">
      <p className="labels-toolbar-note">
        <strong>{count}</strong> {count === 1 ? "label" : "labels"} · print, cut,
        and stick one on each tool. Scanning a sticker opens the tool in Phil.
      </p>
      <div className="flex gap-2">
        <Link href="/gear">
          <Button size="sm" variant="secondary">
            Back to register
          </Button>
        </Link>
        <Button size="sm" onClick={() => window.print()} data-testid="labels-print">
          Print / Save as PDF
        </Button>
      </div>
    </div>
  );
}
