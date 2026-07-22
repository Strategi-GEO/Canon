"use client";

import { ChevronDown, Download, Loader2, Telescope, TriangleAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { AnalysisMetrics } from "@/components/analysis/analysis-metrics";
import { EngineDown, FieldError } from "@/components/clients/engine-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { monthLabel } from "@/lib/analysis";
import { HOSTED_READONLY } from "@/lib/hosted";
import { useAnalysis } from "@/lib/use-analysis";
import { useAnalysisGen } from "@/lib/use-analysis-gen";
import type { AnalysisMonth } from "@/types";

export function AnalysisOverview({ brandSlug, brandName }: { brandSlug: string; brandName: string }) {
  const { data, error, loading, reload } = useAnalysis(brandSlug);
  const gen = useAnalysisGen(brandSlug);
  const [selectedMonth, setSelectedMonth] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<ApiError | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // A run that just finished: pull the fresh analysis into the list and drop the settled job so the
  // progress panel goes away. A failed one is kept so its error stays on screen.
  const genState = gen.job?.state;
  const clearGen = gen.clear;
  React.useEffect(() => {
    if (genState === "done") {
      reload();
      api.clearAnalysisGeneration(brandSlug).catch(() => {});
      clearGen();
    }
  }, [genState, brandSlug, reload, clearGen]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return <EngineDown error={error ?? new ApiError(0, "No data", null)} onRetry={reload} />;
  }

  const month = selectedMonth ?? data.current_month;
  const selected: AnalysisMonth =
    data.analyses.find((r) => r.month === month) ??
    { month, status: "none", analysis: null, has_pdf: false, generated_at: null, generated_by: null };
  const isCurrent = month === data.current_month;
  const running = gen.job?.state === "running";
  const failed = gen.job?.state === "failed";
  const hasWorking = selected.analysis !== null;
  const canAct = !HOSTED_READONLY;
  const canRun = isCurrent && !hasWorking && canAct;

  async function run() {
    setStarting(true);
    setStartError(null);
    try {
      const job = await api.generateAnalysis(brandSlug);
      gen.adopt(job);
    } catch (cause) {
      const err = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      if (err.status === 409) {
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
      const blob = await api.analysisPdf(brandSlug, month);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${brandSlug}-${month}-analysis.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : String(cause);
      toast.error("Could not download the PDF", { description: message });
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.deleteAnalysis(brandSlug, month);
      reload();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : String(cause);
      toast.error("Could not delete", { description: message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header: title, month picker, actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Telescope aria-hidden className="size-5 text-muted-foreground" />
            Analysis
          </h1>
          <p className="text-sm text-muted-foreground">
            The deep six-tool GEO and SEO visibility read for {brandName}.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <MonthPicker
            analyses={data.analyses}
            currentMonth={data.current_month}
            value={month}
            onChange={setSelectedMonth}
          />
          {hasWorking && canAct ? (
            <>
              {selected.has_pdf ? (
                <Button size="sm" variant="outline" onClick={() => void downloadPdf()}>
                  <Download aria-hidden data-icon="inline-start" />
                  PDF
                </Button>
              ) : null}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Trash2 aria-hidden data-icon="inline-start" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete the {monthLabel(month)} analysis?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes the working analysis and its PDF for {brandName}. You can run a
                      fresh one for this month afterwards. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void remove()} disabled={deleting}>
                      {deleting ? "Deleting..." : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : null}
        </div>
      </div>

      {/* Run in flight or failed */}
      {running ? <RunningCard month={data.current_month} /> : null}
      {failed && gen.job?.error ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--fail)" }}>
              <TriangleAlert aria-hidden className="size-4" />
              The analysis failed.
            </div>
            <p className="text-sm text-muted-foreground">{gen.job.error}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void run()} disabled={starting}>
                Try again
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  api.clearAnalysisGeneration(brandSlug).catch(() => {});
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
        <AnalysisMetrics analyses={data.analyses} month={month} />
      ) : running || failed ? null : (
        <EmptyMonth
          month={month}
          isCurrent={isCurrent}
          canRun={canRun}
          starting={starting}
          startError={startError}
          onRun={() => void run()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MonthPicker({
  analyses,
  currentMonth,
  value,
  onChange,
}: {
  analyses: AnalysisMonth[];
  currentMonth: string;
  value: string;
  onChange: (month: string) => void;
}) {
  const months = analyses.map((r) => r.month);
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

function RunningCard({ month }: { month: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        <Loader2 aria-hidden className="size-5 animate-spin text-muted-foreground" />
        <div>
          <div className="text-sm font-medium text-foreground">
            Running the {monthLabel(month)} analysis
          </div>
          <p className="text-sm text-muted-foreground">
            This runs the prompt visibility matrix across six engines and pulls every connected tool,
            so it takes several minutes. You can leave this page; it keeps running.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyMonth({
  month,
  isCurrent,
  canRun,
  starting,
  startError,
  onRun,
}: {
  month: string;
  isCurrent: boolean;
  canRun: boolean;
  starting: boolean;
  startError: ApiError | null;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Telescope aria-hidden className="size-6" />
        </span>
        <div>
          <div className="text-base font-medium text-foreground">
            No analysis for {monthLabel(month)}
          </div>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {canRun
              ? "Run this month's analysis to pull AI prompt visibility, rankings, engagement and outcomes across every connected tool. Tools you have not connected are shown as such and fill in later."
              : isCurrent
                ? "An analysis is being prepared."
                : "This month has no analysis. Analyses are run for the current month."}
          </p>
        </div>
        {canRun ? (
          <Button onClick={onRun} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : (
              <Telescope data-icon="inline-start" aria-hidden />
            )}
            Run {monthLabel(month)} analysis
          </Button>
        ) : null}
        {startError ? <FieldError error={startError} className="mt-1" /> : null}
      </CardContent>
    </Card>
  );
}
