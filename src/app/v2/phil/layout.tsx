import type { ReactNode } from "react";

/**
 * Layout segment for /v2/phil/*. The actual PhilShell chrome wraps each
 * page individually (so individual screens can set their own title), but
 * this layout exists so future /v2/phil/* descendants share a segment.
 */
export default function PhilV2Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
