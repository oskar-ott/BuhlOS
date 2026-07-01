import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { EmployeesScreen } from "./EmployeesScreen";

export const metadata: Metadata = {
  title: "Employees · BuhlOS",
  description: "Add workers, send Phil invites, and track who's set up.",
};

export const dynamic = "force-dynamic";

export default async function EmployeesPage() {
  // #760: employees kill-switch — when the owner turns it off, the surface 404s.
  if (!(await isFlagEnabled("employees", await getCurrentUser()))) notFound();
  return <EmployeesScreen />;
}
