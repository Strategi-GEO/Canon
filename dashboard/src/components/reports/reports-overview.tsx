"use client";

import { ChartColumnIncreasing, ChevronDown, Download, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { EngineDown, FieldError } from "@/components/clients/engine-error";
import { ReportMetrics } from "@/components/reports/report-metrics";
import { DeleteReportDialog } from "@/components/reports/delete-report-dialog";
import { ShareReportDialog } from "@/components/reports/share-report-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { monthLabel } from "@/lib/reports";
import { useReportGen } from "@/lib/use-report-gen";
import { useReports } from "@/lib/use-reports";
import type { MonthReport, ReportStatus } from "@/types";

export function ReportsOverview({ brandSlug, brandName }: { brandSlug: string; brandName: string }) {
  const { data, error, loading, reload } = useReports(brandSlug);
  const gen = useReportGen(brandSlug);
  // The picker holds only an explicit choice; the current month is the default, derived below, so
  // there is no effect syncing state to props.
  const [selectedMonth, setSelectedMonth] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<ApiError | null>(null);

  // A generation that just finished: pull the fresh report into the list and drop the settled
  // job so the progress panel goes away. A failed one is kept so its error stays on screen.
  const genState = gen.job?.state;
  const clearGen = gen.clear;
  React.useEffect(() => {
    if (genState === "done") {
      reload();
      api.clearReportGeneration(brandSlug).catch(() => {});
      clearGen();
    }
  }, [genState, brandSlug, reload, clearGen]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-64 w-full" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </div>
    );
  }
  if (error || !data) {
    return <EngineDown error={error ?? new ApiError(0, "No data", null)} onRetry={reload} />;
  }

  const month = selectedMonth ?? data.current_month;
  const selected: MonthReport =
    data.reports.find((r) => r.month === month) ??
    { month, status: "none", report: null, has_pdf: false, generated_at: null, generated_by: null, shared_at: null, shared_by: null };
  const isCurrent = month === data.current_month;
  const running = gen.job?.state === "running";
  const failed = gen.job?.state === "failed";
  const hasWorking = selected.report !== null;
  // The hosted site is a read-only window: generation, sharing, deleting and the PDF blob all
  // need the live engine, so on hosted the tab shows the metrics and none of the actions, exactly
  // as Send-to-client and the other engine-only controls hide there.
  const canAct = !HOSTED_READONLY;
  const canGenerate = isCurrent && !hasWorking && canAct; // "none" or "deleted_shared" this month

  async function generate() {
    setStarting(true);
    setStartError(null);
    try {
      const job = await api.generateReport(brandSlug);
      gen.adopt(job);
    } catch (cause) {
      const err = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      if (err.status === 409) {
        // Something is already live (a generation or a run): show the reason and re-read the job.
        gen.recheck();
        toast.error("Could not start", { description: err.message });
      } else {
        setStartError(err);
      }
    } finally {
      setStarting(false);
    }
  }

  async function downloadPdf() {
    try {
      const blob = await api.reportPdf(brandSlug, month);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${brandSlug}-${month}-report.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : String(cause);
      toast.error("Could not download the PDF", { description: message });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header: title, month picker, actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <ChartColumnIncreasing aria-hidden className="size-5 text-muted-foreground" />
            Reports
          </h1>
          <p className="text-sm text-muted-foreground">
            Coverage, links and AI visibility for {brandName}.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <MonthPicker
            reports={data.reports}
            currentMonth={data.current_month}
            value={month}
            onChange={setSelectedMonth}
          />
          {hasWorking ? (
            <>
              {selected.has_pdf ? (
                <Button size="sm" variant="outline" onClick={() => void downloadPdf()}>
                  <Download aria-hidden data-icon="inline-start" />
                  PDF
                </Button>
              ) : null}
              <ShareReportDialog
                brandSlug={brandSlug}
                brandName={brandName}
                month={month}
                resend={selected.status === "generated_shared"}
                onShared={reload}
              />
              <DeleteReportDialog
                brandSlug={brandSlug}
                month={month}
                isShared={selected.shared_at !== null}
                onDeleted={reload}
              />
            </>
          ) : null}
        </div>
      </div>

      {/* Sharing status banner */}
      <StatusBanner status={selected.status} sharedAt={selected.shared_at} sharedBy={selected.shared_by} />

      {/* Generation in flight or failed */}
      {running ? <GeneratingCard month={data.current_month} /> : null}
      {failed && gen.job?.error ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--fail)" }}>
              <TriangleAlert aria-hidden className="size-4" />
              The report generation failed.
            </div>
            <p className="text-sm text-muted-foreground">{gen.job.error}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void generate()} disabled={starting}>
                Try again
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  api.clearReportGeneration(brandSlug).catch(() => {});
                  gen.clear();
                }}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Body */}
      {hasWorking ? (
        <ReportMetrics reports={data.reports} month={month} />
      ) : running || failed ? null : (
        <EmptyMonth
          month={month}
          status={selected.status}
          isCurrent={isCurrent}
          canGenerate={canGenerate}
          starting={starting}
          startError={startError}
          onGenerate={() => void generate()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MonthPicker({
  reports,
  currentMonth,
  value,
  onChange,
}: {
  reports: MonthReport[];
  currentMonth: string;
  value: string;
  onChange: (month: string) => void;
}) {
  // Every month in the list, newest first, plus the current month if the list somehow omits it.
  const months = reports.map((r) => r.month);
  if (!months.includes(currentMonth)) months.unshift(currentMonth);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          {monthLabel(value)}
          <ChevronDown aria-hidden data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {months.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {monthLabel(m)}
              {m === currentMonth ? <span className="ml-1 text-muted-foreground">(current)</span> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusBanner({
  status,
  sharedAt,
  sharedBy,
}: {
  status: ReportStatus;
  sharedAt: string | null;
  sharedBy: string | null;
}) {
  if (status === "generated_shared" && sharedAt) {
    return (
      <Banner tone="ship">
        Shared with the client on {formatDate(sharedAt)}
        {sharedBy ? ` by ${sharedBy}` : ""}. They are seeing this exact report.
      </Banner>
    );
  }
  if (status === "generated_unshared") {
    return (
      <Banner tone="review">
        Not shared with the client yet. Send it when you are happy, and they will see it in their portal.
      </Banner>
    );
  }
  if (status === "deleted_shared") {
    return (
      <Banner tone="review" icon={<TriangleAlert aria-hidden className="size-4" />}>
        No report generated for this month. The client is still seeing the report you shared
        {sharedAt ? ` on ${formatDate(sharedAt)}` : ""}. Generate a new one to replace what they see.
      </Banner>
    );
  }
  return null;
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "ship" | "review";
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const color = tone === "ship" ? "var(--ship)" : "var(--review)";
  const bg = tone === "ship" ? "var(--ship-bg)" : "var(--review-bg)";
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm"
      style={{ color, backgroundColor: bg }}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function GeneratingCard({ month }: { month: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        <Loader2 aria-hidden className="size-5 animate-spin text-muted-foreground" />
        <div>
          <div className="text-sm font-medium text-foreground">
            Generating the {monthLabel(month)} report
          </div>
          <p className="text-sm text-muted-foreground">
            This runs a full audit across DataForSEO and the live site, so it takes a few minutes.
            You can leave this page; it keeps running.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyMonth({
  month,
  status,
  isCurrent,
  canGenerate,
  starting,
  startError,
  onGenerate,
}: {
  month: string;
  status: ReportStatus;
  isCurrent: boolean;
  canGenerate: boolean;
  starting: boolean;
  startError: ApiError | null;
  onGenerate: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Sparkles aria-hidden className="size-6" />
        </span>
        <div>
          <div className="text-base font-medium text-foreground">
            {status === "deleted_shared"
              ? `No report for ${monthLabel(month)}`
              : `No report generated for ${monthLabel(month)}`}
          </div>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {canGenerate
              ? "Generate this month's report to pull AI visibility, backlinks and referring domains, then send it to the client."
              : isCurrent
                ? "A report is being prepared."
                : "This month has no report. Reports are generated for the current month."}
          </p>
        </div>
        {canGenerate ? (
          <Button onClick={onGenerate} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : (
              <Sparkles data-icon="inline-start" aria-hidden />
            )}
            Generate {monthLabel(month)} report
          </Button>
        ) : null}
        {startError ? <FieldError error={startError} className="mt-1" /> : null}
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
