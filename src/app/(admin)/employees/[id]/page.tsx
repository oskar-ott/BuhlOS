import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { EmployeesScreen } from "../EmployeesScreen";

export const metadata: Metadata = {
  title: "Employee · BuhlOS",
  description: "Employee detail — invite status, jobs, gear and admin actions.",
};

export const dynamic = "force-dynamic";

/**
 * /employees/[id] — deep-link straight to one worker's detail drawer over the
 * register (bible §15 routes). Renders the same screen, opening the drawer for
 * the given id on mount.
 */
export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // #760: employees kill-switch — when the owner turns it off, the surface 404s.
  if (!(await isFlagEnabled("employees", await getCurrentUser()))) notFound();
  return <EmployeesScreen selectedId={id} />;
}
