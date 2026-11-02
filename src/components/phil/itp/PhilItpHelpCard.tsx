"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilItpWalkthrough } from "./PhilItpWalkthrough";

/**
 * Settings → Help → How ITPs work (board 9, last column): one row on the
 * account screen that replays the four-step walkthrough from step 1,
 * regardless of the seen flag.
 */
export function PhilItpHelpCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>Help</CardTitle>
        <CardDescription>Short walkthroughs of how things work on the phone.</CardDescription>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="more-itp-help"
        className="flex min-h-[56px] w-full items-center justify-between rounded-card border border-border bg-surface px-4 text-left text-[17px] font-semibold text-text hover:border-brand-navy focus-visible:outline-brand-navy"
      >
        <span>How ITPs work</span>
        <ChevronRight aria-hidden="true" className="h-5 w-5 text-text-muted" />
      </button>
      <PhilItpWalkthrough open={open} onSkip={() => setOpen(false)} onDone={() => setOpen(false)} />
    </Card>
  );
}
