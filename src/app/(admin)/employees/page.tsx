import type { Metadata } from "next";
import { EmployeesScreen } from "./EmployeesScreen";

export const metadata: Metadata = {
  title: "Employees · BuhlOS",
  description: "Add workers, send Phil invites, and track who's set up.",
};

export const dynamic = "force-dynamic";

export default function EmployeesPage() {
  return <EmployeesScreen />;
}
