import { AppShell } from "@/components/shell/app-shell";

/**
 * The ADMIN interface's shell, mounted for every /admin/* route and nowhere else. AppShell
 * carries the operator providers (orgs, clients, runs, notifications) and the admin chrome,
 * plus the guard that sends a signed-out caller to /login and a non-operator to the root
 * (which routes them on to their own client space). The client portal has its own shell in
 * the sibling layout, so a client never loads any of this.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
