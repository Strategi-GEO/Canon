"use client";

/**
 * The KPI dashboard for one month, drawn from that month's metrics plus the all-months series for
 * deltas and the trend line. It is the same visual the operator and the client both see: the
 * admin Reports tab and the client portal Reports view each render this, so a shared report looks
 * identical on both sides. It assumes the selected month HAS metrics; the empty states (nothing
 * generated, nothing shared) belong to the callers.
 */
import { Gauge, Globe, Link2, ListChecks, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Delta, EngineBars, Sparkline, TrendChart, type EngineRow, type TrendPoint } from "@/components/reports/charts";
import {
  deltaAt,
  lighthouseBand,
  lighthouseScore,
  mentionTotal,
  metricSeries,
  monthLabel,
  selBacklinks,
  selEngine,
  selReferring,
  selTotal,
} from "@/lib/reports";
import type { MonthReport, ReportLighthouse, ReportPriorityFix } from "@/types";

export function ReportMetrics({ reports, month }: { reports: MonthReport[]; month: string }) {
  const selected = reports.find((r) => r.month === month);
  const metrics = selected?.report?.metrics;
  if (!metrics) return null;

  // The rest of the audit the skill wrote into this month's report. Both ride in the same stored
  // report.json the PDF renders, so the dashboard shows the real pulled numbers, never a stand-in.
  const lighthouse = selected?.report?.lighthouse ?? null;
  const actionPlan = selected?.report?.priority_fixes ?? [];

  const series = metricSeries(reports);
  const total = mentionTotal(metrics);
  const totalDelta = deltaAt(series, month, selTotal);
  const prevTotal = totalDelta && total !== null ? total - totalDelta.abs : null;

  const engineRows: EngineRow[] = (metrics.ai_mentions?.by_engine ?? []).map((e) => ({
    label: e.engine,
    value: e.value,
    delta: deltaAt(series, month, selEngine(e.engine)),
  }));

  const trend: TrendPoint[] = series.map((p) => ({
    month: p.month,
    label: p.label,
    value: mentionTotal(p.metrics),
  }));

  return (
    <div className="flex flex-col gap-4">
      {/* AI visibility: the headline card */}
      <Card>
        <CardContent className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className="flex size-9 items-center justify-center rounded-lg"
                style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
              >
                <Sparkles aria-hidden className="size-4.5" />
              </span>
              <div>
                <div className="text-base font-semibold text-foreground">AI visibility</div>
                <div className="text-sm text-muted-foreground">Mentions across AI answer engines</div>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">{metrics.month_label || monthLabel(month)}</div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
            {/* left: hero + engine bars */}
            <div>
              <div className="flex items-end gap-3">
                <div className="text-6xl font-semibold leading-none tracking-tight text-foreground">
                  {total === null ? "n/a" : total.toLocaleString("en-US")}
                </div>
                <Delta delta={totalDelta} className="mb-2" />
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                AI mentions in {metrics.month_label || monthLabel(month)}
                {prevTotal !== null ? ` (from ${prevTotal.toLocaleString("en-US")} last month)` : ""}
              </p>

              <div className="mt-6">
                <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  By engine
                </div>
                {engineRows.length > 0 ? (
                  <EngineBars rows={engineRows} />
                ) : (
                  <p className="text-sm text-muted-foreground">No per-engine data this month.</p>
                )}
              </div>
            </div>

            {/* right: all-months trend */}
            <div className="min-w-0">
              <TrendChart points={trend} unit="mentions" />
            </div>
          </div>

          {metrics.note ? <p className="mt-4 text-xs text-muted-foreground">{metrics.note}</p> : null}
        </CardContent>
      </Card>

      {/* Google Lighthouse: real scores pulled this month */}
      {lighthouse ? <LighthouseCard lighthouse={lighthouse} /> : null}

      {/* backlinks + referring domains */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile
          icon={<Link2 aria-hidden className="size-4" />}
          label="Backlinks"
          value={metrics.backlinks}
          delta={deltaAt(series, month, selBacklinks)}
          series={series.map((p) => selBacklinks(p.metrics))}
        />
        <StatTile
          icon={<Globe aria-hidden className="size-4" />}
          label="Referring domains"
          value={metrics.referring_domains}
          delta={deltaAt(series, month, selReferring)}
          series={series.map((p) => selReferring(p.metrics))}
        />
      </div>

      {/* Plan of action: the fixes the audit found, quickest wins first */}
      {actionPlan.length > 0 ? <ActionPlanCard fixes={actionPlan} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google Lighthouse
// ---------------------------------------------------------------------------

const BAND_COLOR: Record<"good" | "mid" | "bad" | "na", string> = {
  good: "var(--ship)",
  mid: "var(--review)",
  bad: "var(--fail)",
  na: "var(--muted-foreground)",
};

/**
 * The recognisable Lighthouse gauge: a ring filled to the score and coloured on Google's own
 * bands (90+ green, 50 to 89 amber, below 50 red). A missing score draws an empty ring and a
 * dash rather than a zero, because "not measured" is not the same claim as "scored zero".
 */
function ScoreGauge({ score, size = 60 }: { score: number | null; size?: number }) {
  const band = lighthouseBand(score);
  const color = BAND_COLOR[band];
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={score === null ? "Not measured" : `${score} out of 100`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
      {score !== null ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        style={{ fontSize: size * 0.3, fontWeight: 600, fill: color, fontVariantNumeric: "tabular-nums" }}
      >
        {score === null ? "-" : score}
      </text>
    </svg>
  );
}

function LighthouseCard({ lighthouse }: { lighthouse: ReportLighthouse }) {
  const scores = lighthouse.scores ?? [];
  if (scores.length === 0) return null;
  const hasMobile = scores.some((s) => lighthouseScore(s.mobile) !== null);

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Gauge aria-hidden className="size-4.5" />
            </span>
            <div>
              <div className="text-base font-semibold text-foreground">Google Lighthouse</div>
              <div className="text-sm text-muted-foreground">
                Real Lighthouse scores{hasMobile ? ", desktop and mobile" : ", desktop"}
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
            <LegendDot color="var(--ship)" label="90+" />
            <LegendDot color="var(--review)" label="50 to 89" />
            <LegendDot color="var(--fail)" label="Below 50" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
          {scores.map((s) => {
            const desktop = lighthouseScore(s.desktop);
            const mobile = lighthouseScore(s.mobile);
            return (
              <div key={s.category} className="flex flex-col items-center gap-2 text-center">
                <ScoreGauge score={desktop} />
                <div className="text-xs font-medium text-foreground leading-tight">{s.category}</div>
                {hasMobile ? (
                  <div className="text-xs text-muted-foreground">
                    Mobile{" "}
                    <span
                      className="font-medium tabular-nums"
                      style={{ color: BAND_COLOR[lighthouseBand(mobile)] }}
                    >
                      {mobile === null ? "n/a" : mobile}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {lighthouse.form_factor_note ? (
          <p className="mt-5 text-xs text-muted-foreground">{lighthouse.form_factor_note}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Plan of action
// ---------------------------------------------------------------------------

const SEVERITY_STYLE: Record<string, { color: string; bg: string }> = {
  high: { color: "var(--fail)", bg: "var(--fail-bg)" },
  medium: { color: "var(--review)", bg: "var(--review-bg)" },
  low: { color: "var(--muted-foreground)", bg: "var(--muted)" },
  verify: { color: "var(--primary)", bg: "var(--muted)" },
};

/**
 * The audit's plan of action, exactly as the skill ordered it (quick wins first). Each item is a
 * suggested fix plus why it earns its place; the pill carries the effort, coloured by severity.
 * This is the same list the PDF renders, so the on-screen report and the download agree.
 */
function ActionPlanCard({ fixes }: { fixes: ReportPriorityFix[] }) {
  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <ListChecks aria-hidden className="size-4.5" />
          </span>
          <div>
            <div className="text-base font-semibold text-foreground">Plan of action</div>
            <div className="text-sm text-muted-foreground">
              What to fix, quickest wins first. Full detail is in the PDF.
            </div>
          </div>
        </div>

        <ol className="flex flex-col gap-4">
          {fixes.map((f, i) => {
            const sev = (f.severity ?? "medium").toLowerCase();
            const style = SEVERITY_STYLE[sev] ?? SEVERITY_STYLE.medium;
            return (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-foreground">{f.fix}</span>
                    {f.effort || f.severity ? (
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ color: style.color, backgroundColor: style.bg }}
                      >
                        {f.effort || f.severity}
                      </span>
                    ) : null}
                  </div>
                  {f.why ? <p className="mt-1 text-sm text-muted-foreground">{f.why}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  value,
  delta,
  series,
}: {
  icon: ReactNode;
  label: string;
  value: number | null;
  delta: ReturnType<typeof deltaAt>;
  series: (number | null)[];
}) {
  const spark = series.filter((v): v is number => v !== null);
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <span className="text-muted-foreground">{icon}</span>
          {label}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-end gap-2">
            <div className="text-3xl font-semibold leading-none tabular-nums text-foreground">
              {value === null || value === undefined ? "n/a" : value.toLocaleString("en-US")}
            </div>
            <Delta delta={delta} className="mb-0.5" />
          </div>
          <div className="w-32">
            {spark.length > 1 ? <Sparkline values={spark} /> : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
