import { redirect } from "next/navigation";
import type { Route } from "next";
import { getCurrentUser } from "@/lib/auth/current-user";
import { landingFor } from "@/lib/auth/landing";

/**
 * Root entry — in production `/` is rewritten by vercel.json to /login.html
 * (legacy), so this component is only hit in dev or when the rewrite is
 * disabled (Phase B+).
 *
 * Behaviour: if the user has a valid session, send them to their landing.
 * If not, send them to /v2/login.
 *
 * The `as Route` cast is intentional: landingFor() may return /lh or /client,
 * which are owned by vercel.json (legacy) and therefore not known to Next.js
 * typedRoutes. Cast goes away in Phase B+ when those move into src/app/.
 */
export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user?.role) redirect("/v2/login");
  redirect(landingFor(user.role) as Route);
}
