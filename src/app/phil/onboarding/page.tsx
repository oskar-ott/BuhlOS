import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { canAccessSurface } from "@/lib/auth/permissions";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const metadata: Metadata = {
  title: "Welcome to Phil · BuhlOS",
  description:
    "Quick three-minute onboarding for new field workers. Confirm who you are, see what Phil does, then jump into your day.",
};

export const dynamic = "force-dynamic";

/**
 * /phil/onboarding — first-run experience for new Phil users.
 *
 * Implements the Phil onboarding design from the Claude Design handoff
 * (handoff_buhlos/prototypes/Onboarding.html). Nine screens (Welcome,
 * Identity, Hours, Gear, Jobs, Job interface, Site data, Permissions,
 * Ready) that take a new tradie from "first login" to "ready on site"
 * in under three minutes.
 *
 * Gated to field / leading-hand roles via middleware — same surface as
 * /phil/my-day. Admin/office users get bounced back to /v2/login.
 */
export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user?.role) redirect("/v2/login?next=/phil/onboarding");
  if (!canAccessSurface(user.role, "phil")) redirect("/v2/login");

  return (
    <OnboardingFlow
      user={{
        name: user.name ?? null,
        email: user.email ?? null,
        role: user.role ?? null,
      }}
      appHref={"/phil/my-day" as Route}
    />
  );
}
