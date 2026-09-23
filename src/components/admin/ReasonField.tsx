"use client";

import { useId } from "react";

interface ReasonFieldProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Validation or server error — rendered INSIDE the dialog, under the
   *  textarea, so it is never hidden behind the modal backdrop. */
  error?: string | null;
  disabled?: boolean;
}

/**
 * The required-reason textarea shared by the office's send-back dialogs
 * (approvals queue reject, weekly board reject + reopen). The error lives next
 * to the field it is about (role="alert" + aria-describedby), not at page level
 * behind the open modal where nobody can see it.
 */
export function ReasonField({
  label = "Reason (required)",
  value,
  onChange,
  placeholder,
  error,
  disabled = false,
}: ReasonFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="text-sm">
      <label htmlFor={id} className="mb-1 block font-medium text-text">
        {label}
      </label>
      <textarea
        id={id}
        autoFocus
        required
        aria-required="true"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        rows={3}
        maxLength={500}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
