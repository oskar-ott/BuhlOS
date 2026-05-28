import type { Metadata } from "next";
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
  return <EmployeesScreen selectedId={id} />;
}
