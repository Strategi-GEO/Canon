"use client";

import { ChevronDown, Sparkles } from "lucide-react";
import * as React from "react";

import { ReportMetrics } from "@/components/reports/report-metrics";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { monthLabel } from "@/lib/reports";
import { ApiError, api, detailText } from "@/portal/api";
import type { PortalReports } from "@/portal/types";
import type { MonthReport } from "@/types";

/**
 * The client's monthly report, and ONLY what the team has shared. Past shared months are
 * viewable; a month the team has generated but not sent (or not generated at all) reads "not
 * available yet". It renders the same KPI dashboard the admin sees, from the shared snapshot,
 * so a report looks identical on both sides.
 */
export function ReportsView({ brand }: { brand: string }) {
  const [data, setData] = React.useState<PortalReports | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [month, setMonth] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    api
      .reports(brand, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setData(res);
          setError(null);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError) setError(cause);
        else if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(new ApiError(0, String(cause)));
        }
      });
    return () => controller.abort();
  }, [brand, attempt]);

  if (error !== null) {
    return (
      <div className="rounded-lg border bg-card px-4 py-3">
        <p className="text-sm text-muted-foreground">{detailText(error)}</p>
        <Button
          className="mt-2"
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="space-y-3" aria-busy>
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-28 animate-pulse rounded-lg bg-muted" />
          <div className="h-28 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  const shared = data.months; // newest first, shared only
  // The picker offers every shared month plus the current month, so the client can land on this
  // month and be told it is not available yet rather than never seeing it at all.
  const monthsForPicker = shared.map((m) => m.month);
  if (!monthsForPicker.includes(data.current_month)) monthsForPicker.unshift(data.current_month);

  const selected = month ?? (shared[0]?.month ?? data.current_month);
  const sharedForSelected = shared.find((m) => m.month === selected) ?? null;

  const asMonthReports: MonthReport[] = shared.map((m) => ({
    month: m.month,
    status: "generated_shared",
    report: m.report,
    has_pdf: m.has_pdf,
    generated_at: m.shared_at,
    generated_by: null,
    shared_at: m.shared_at,
    shared_by: null,
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Coverage, links and AI visibility for {data.brand_name}.
        </p>
        {monthsForPicker.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                {monthLabel(selected)}
                <ChevronDown aria-hidden data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup value={selected} onValueChange={setMonth}>
                {monthsForPicker.map((m) => (
                  <DropdownMenuRadioItem key={m} value={m}>
                    {monthLabel(m)}
                    {m === data.current_month ? (
                      <span className="ml-1 text-muted-foreground">(current)</span>
                    ) : null}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {sharedForSelected ? (
        <ReportMetrics reports={asMonthReports} month={selected} />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Sparkles aria-hidden className="size-6" />
            </span>
            <div>
              <div className="text-base font-medium text-foreground">
                Report not available yet
              </div>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                The {monthLabel(selected)} report has not been shared with you yet. It will appear
                here as soon as your team publishes it.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
