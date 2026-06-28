import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Initials avatar (prototype `.avatar`) + an overlapping `.avatar-stack`.
 * Initials are DERIVED from the name — never a fetched image (honesty: we don't
 * pretend to have photos we don't hold).
 */
export type AvatarTone = "navy" | "amber" | "yellow";
type AvatarSize = "sm" | "lg";

const TONE: Record<AvatarTone, string> = {
  navy: "bg-brand-navy text-text-inverse",
  amber: "bg-amber-100 text-amber-900",
  yellow: "bg-accent-yellow text-brand-navy",
};

const SIZE: Record<AvatarSize, string> = {
  sm: "h-7 w-7 text-[11px]",
  lg: "h-9 w-9 text-[13px]",
};

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

interface AvatarProps {
  name: string;
  tone?: AvatarTone;
  size?: AvatarSize;
  className?: string;
}

export function Avatar({ name, tone = "navy", size = "sm", className }: AvatarProps) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-display font-semibold",
        TONE[tone],
        SIZE[size],
        className
      )}
    >
      {initialsFromName(name)}
    </span>
  );
}

/** Overlapping cluster of avatars. */
export function AvatarStack({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center -space-x-2", className)}>{children}</span>;
}
