"use client";

import { type ReactNode, useRef } from "react";

export function Pill({ tone, dotted, children }: { tone: string; dotted?: boolean; children: ReactNode }) {
  return (
    <span className={"pill " + tone}>
      {dotted && <span className={"dot " + (tone === "green" ? "" : tone)} />}
      {children}
    </span>
  );
}

/** Inline contentEditable cell — commits on blur / Enter. Numeric strips to a number. */
export function EditCell({
  value,
  numeric,
  onCommit,
  className,
}: {
  value: string | number;
  numeric?: boolean;
  onCommit: (v: string | number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const commit = () => {
    const raw = (ref.current?.textContent ?? "").trim();
    if (numeric) {
      const n = parseFloat(raw.replace(/[^\d.]/g, ""));
      onCommit(Number.isNaN(n) ? 0 : n);
    } else {
      onCommit(raw);
    }
  };
  return (
    <span
      ref={ref}
      className={"c-edit " + (className || "")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    >
      {value}
    </span>
  );
}

/** Inline fixed-choice dropdown (device, poles, curve, cores, rcd…). */
export function SelectCell({
  value,
  options,
  onCommit,
  title,
  wide,
}: {
  value: string;
  options: readonly string[];
  onCommit: (v: string) => void;
  title?: string;
  wide?: boolean;
}) {
  return (
    <select
      className={"c-sel" + (wide ? " wide" : "")}
      value={value}
      title={title}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => onCommit(e.target.value)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
