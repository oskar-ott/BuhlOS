"use client";

import { useCallback, useMemo } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { WelcomeStep } from "./steps/Welcome";
import { IdentityStep } from "./steps/Identity";
import { HoursStep } from "./steps/Hours";
import { GearStep } from "./steps/Gear";
import { JobsStep } from "./steps/Jobs";
import { JobInterfaceStep } from "./steps/JobInterface";
import { SiteDataStep } from "./steps/SiteData";
import { PermissionsStep } from "./steps/Permissions";
import { ReadyStep } from "./steps/Ready";
import { isStepId, nextStep, type StepId } from "./steps";

interface OnboardingFlowProps {
  user: {
    name: string | null;
    email: string | null;
    role: string | null;
  };
  /**
   * Where the flow lands when the worker hits Open Phil at the end.
   * Passed as a Route-typed string so typedRoutes is satisfied (the page
   * entry passes "/phil/my-day"). Kept as a prop so deep tests can swap it.
   */
  appHref: Route;
}

/**
 * Client-side step orchestrator. Step state is held in the URL via the
 * `step` query param so deep-links and back/forward work naturally. The
 * default step is Welcome.
 *
 * Navigation uses router.replace (not push) for forward step transitions
 * so the back button collapses the whole funnel — workers shouldn't have
 * to back-tap through 8 screens to leave.
 */
export function OnboardingFlow({ user, appHref }: OnboardingFlowProps) {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("step");
  const step: StepId = isStepId(raw) ? raw : "welcome";

  const goTo = useCallback(
    (next: StepId) => {
      const q = new URLSearchParams(params.toString());
      if (next === "welcome") q.delete("step");
      else q.set("step", next);
      const qs = q.toString();
      // typedRoutes can't statically verify a runtime-built query string,
      // so we cast. The base path /phil/onboarding is the routed page.
      const href = `/phil/onboarding${qs ? `?${qs}` : ""}` as Route;
      router.replace(href);
    },
    [params, router]
  );

  const skip = useCallback(() => goTo("ready"), [goTo]);
  const advance = useMemo(() => () => goTo(nextStep(step)), [goTo, step]);

  switch (step) {
    case "welcome":
      return (
        <WelcomeStep
          onContinue={advance}
          onSkipToApp={() => router.push(appHref)}
        />
      );
    case "identity":
      return (
        <IdentityStep
          name={user.name}
          email={user.email}
          role={user.role}
          onContinue={advance}
        />
      );
    case "hours":
      return <HoursStep onContinue={advance} onSkip={skip} />;
    case "gear":
      return <GearStep onContinue={advance} onSkip={skip} />;
    case "jobs":
      return <JobsStep onContinue={advance} onSkip={skip} />;
    case "job-interface":
      return <JobInterfaceStep onContinue={advance} onSkip={skip} />;
    case "site-data":
      return <SiteDataStep onContinue={advance} onSkip={skip} />;
    case "permissions":
      return <PermissionsStep onContinue={advance} onSkip={skip} />;
    case "ready":
      return (
        <ReadyStep
          name={user.name}
          onOpenApp={() => router.push(appHref)}
          onReview={() => goTo("welcome")}
        />
      );
  }
}
