import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine class names, merging Tailwind utility conflicts.
 *
 * Example:
 *   cn("px-2 py-1", isActive && "bg-accent-yellow", className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
