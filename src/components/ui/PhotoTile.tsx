import { cn } from "@/lib/cn";

/**
 * Photo / plan placeholder tile (prototype `.photo-tile`): a dashed-bordered
 * slot with a mono caption for any image we don't (yet) have a real thumbnail
 * for. Honesty: it reads as an explicit placeholder ("IMG" / "PLAN"), never a
 * fake photo.
 */
export function PhotoTile({
  caption = "IMG",
  className,
}: {
  caption?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex aspect-square items-center justify-center rounded-card border border-dashed border-border bg-surface-subtle",
        className
      )}
      aria-hidden="true"
    >
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {caption}
      </span>
    </div>
  );
}
