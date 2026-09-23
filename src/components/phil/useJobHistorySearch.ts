"use client";

import { useEffect, useState } from "react";
import { searchJobHistory } from "@/domains/jobs/client";
import type { Job } from "@/domains/jobs/types";

export type JobHistorySearch =
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | { kind: "ready"; query: string; jobs: ReadonlyArray<Job> }
  | { kind: "failed"; query: string };

/**
 * Server search over the jobs the crew can no longer see in their default
 * list — the closed ones (docs/job-lifecycle.md). Runs once the query has
 * two characters, debounced, and drops stale answers. `enabled` lets a
 * caller hold fire while the query already matches locally.
 */
export function useJobHistorySearch(query: string, enabled = true): JobHistorySearch {
  const [state, setState] = useState<JobHistorySearch>({ kind: "idle" });
  const q = query.trim();

  useEffect(() => {
    if (!enabled || q.length < 2) {
      setState({ kind: "idle" });
      return;
    }
    let alive = true;
    setState({ kind: "searching", query: q });
    const t = setTimeout(() => {
      searchJobHistory(q)
        .then((res) => {
          if (!alive) return;
          setState(res.ok ? { kind: "ready", query: q, jobs: res.data.jobs } : { kind: "failed", query: q });
        })
        .catch(() => {
          if (alive) setState({ kind: "failed", query: q });
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, enabled]);

  return state;
}
