"use client";

import { Button } from "@/components/ui/Button";

/** Print/Save-as-PDF trigger for the compliance pack — hidden when printing. */
export function PackPrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()} data-testid="pack-print">
      Print / Save as PDF
    </Button>
  );
}
