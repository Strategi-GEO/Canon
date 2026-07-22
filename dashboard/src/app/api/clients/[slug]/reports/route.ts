import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { failure, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";
import type { MonthReport, ReportDocument, ReportStatus } from "@/types";

/**
 * The hosted mirror of the engine's GET /api/clients/{slug}/reports. It reads the WORKING report
 * per month through the admin_report_months definer function (gated on auth_is_admin(), so a
 * non-admin JWT gets an empty list rather than a refusal), and shapes it byte-for-byte like the
 * engine: the current month is always present so the tab can show its empty state, and status is
 * derived here from the same timestamp rule the engine uses. The hosted tab is read-only, so
 * there is no generate, share, delete or PDF here; those live in the Canon app.
 */
type AdminRow = {
  month: string;
  report: ReportDocument | null;
  has_pdf: boolean;
  generated_at: string | null;
  generated_by: string | null;
  shared_at: string | null;
  shared_by: string | null;
  has_shared: boolean;
};

function reportStatus(
  hasWorking: boolean,
  generatedAt: string | null,
  sharedAt: string | null,
  hasShared: boolean,
): ReportStatus {
  if (hasWorking) {
    if (sharedAt !== null && generatedAt !== null && sharedAt >= generatedAt) {
      return "generated_shared";
    }
    return "generated_unshared";
  }
  if (hasShared) return "deleted_shared";
  return "none";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) return unauthenticated();
  const { slug } = await params;
  try {
    const rows = (await rpc<AdminRow[]>(user.token, "admin_report_months", { p_brand: slug })) ?? [];
    const current = new Date().toISOString().slice(0, 7);
    const reports: MonthReport[] = rows.map((row) => ({
      month: row.month,
      status: reportStatus(row.report !== null, row.generated_at, row.shared_at, row.has_shared),
      report: row.report ?? null,
      has_pdf: !!row.has_pdf,
      generated_at: row.generated_at ?? null,
      generated_by: row.generated_by ?? null,
      shared_at: row.shared_at ?? null,
      shared_by: row.shared_by ?? null,
    }));
    if (!reports.some((r) => r.month === current)) {
      reports.push({
        month: current,
        status: "none",
        report: null,
        has_pdf: false,
        generated_at: null,
        generated_by: null,
        shared_at: null,
        shared_by: null,
      });
    }
    reports.sort((a, b) => b.month.localeCompare(a.month));
    return json({ current_month: current, reports });
  } catch (cause) {
    return failure(cause);
  }
}
