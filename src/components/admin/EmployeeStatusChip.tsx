import { StatusChip } from "@/components/ui/StatusChip";
import { employeeStatusMarker } from "@/domains/employees/service";
import type { Employee, InvitePublic } from "@/domains/employees/types";

interface EmployeeStatusChipProps {
  employee: Pick<Employee, "status">;
  invite?: Pick<InvitePublic, "status"> | null;
}

/**
 * Single chip rendering the combined employee + invite state, using the fixed
 * status vocabulary from bible §08 (Draft · Invited · Opened · Active ·
 * Expired · Revoked · Failed · Disabled). The marker — label + tone — is
 * derived in the domain so the UI never invents chip words.
 */
export function EmployeeStatusChip({ employee, invite }: EmployeeStatusChipProps) {
  const marker = employeeStatusMarker(employee, invite ?? null);
  return <StatusChip tone={marker.tone}>{marker.label}</StatusChip>;
}
