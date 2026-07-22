"use client";

/**
 * The on-screen Analysis dashboard for one month, drawn from that month's normalized analysis.json
 * plus the all-months series for scorecard deltas. It renders the SAME data the branded PDF does,
 * so the screen and the download never disagree. Every section is guarded on presence: a tool that
 * was not connected produced no section, so the section simply does not render (graceful
 * degradation), and its scorecard card shows greyed as "Not connected".
 */
import {
  Activity, BadgeCheck, Gauge, Globe, Layers, ListChecks, Search, Sparkles, Target, Telescope, TrendingUp,
} from "lucide-react";
import type { ReactNode } from "react";

import { Delta, Sparkline } from "@/components/reports/charts";
import { Card, CardContent } from "@/components/ui/card";
import { analysisSeries, cardDelta, cellTone, monthLabel } from "@/lib/analysis";
import { lighthouseBand, lighthouseScore } from "@/lib/reports";
import type {
  AnalysisDocument, AnalysisMonth, AnalysisScorecardCard,
} from "@/types";

const BAND_COLOR: Record<"good" | "mid" | "bad" | "na", string> = {
  good: "var(--ship)", mid: "var(--review)", bad: "var(--fail)", na: "var(--muted-foreground)",
};

export function AnalysisMetrics({ analyses, month }: { analyses: AnalysisMonth[]; month: string }) {
  const selected = analyses.find((r) => r.month === month);
  const a = selected?.analysis;
  if (!a) return null;
  const series = analysisSeries(analyses);

  return (
    <div className="flex flex-col gap-4">
      <ToolStrip tools={a.tools} />
      <Scorecard cards={a.scorecard} month={month} series={series} />
      {a.executive_summary ? <ExecutiveSummary summary={a.executive_summary} /> : null}
      <PromptMatrix matrix={a.ai_visibility.prompt_matrix} />
      {a.ai_visibility.citations?.length || a.ai_visibility.gaps?.length ? (
        <CitationsGaps ai={a.ai_visibility} />
      ) : null}
      {a.ai_visibility.referral_traffic?.by_source?.length ? (
        <ReferralTraffic rows={a.ai_visibility.referral_traffic.by_source} />
      ) : null}
      {a.ai_visibility.bing_indicator ? <BingIndicator bing={a.ai_visibility.bing_indicator} /> : null}
      {a.ai_visibility.ai_overview?.length ? <AiOverview rows={a.ai_visibility.ai_overview} /> : null}
      {a.seo_visibility ? <SeoSection seo={a.seo_visibility} /> : null}
      {a.engagement ? <EngagementSection engagement={a.engagement} /> : null}
      {a.outcomes ? <Outcomes outcomes={a.outcomes} /> : null}
      {a.plan ? <PlanSection plan={a.plan} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared section frame + small pieces
// ---------------------------------------------------------------------------

function Section({
  icon, title, subtitle, right, children,
}: {
  icon: ReactNode; title: string; subtitle?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {icon}
            </span>
            <div>
              <div className="text-base font-semibold text-foreground">{title}</div>
              {subtitle ? <div className="text-sm text-muted-foreground">{subtitle}</div> : null}
            </div>
          </div>
          {right}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function toDelta(cd: { abs: number; pct: number | null } | null) {
  return cd ? { abs: cd.abs, pct: cd.pct, prevMonth: "" } : null;
}

function Th({ children, num = false }: { children: ReactNode; num?: boolean }) {
  return (
    <th className={`border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground ${num ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
function Td({ children, num = false, mono = false }: { children: ReactNode; num?: boolean; mono?: boolean }) {
  return (
    <td className={`border-b border-border px-3 py-2 align-top text-sm text-foreground ${num ? "text-right tabular-nums" : ""} ${mono ? "font-mono text-xs wrap-anywhere" : ""}`}>
      {children}
    </td>
  );
}
function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools strip: the degradation surface, made visible
// ---------------------------------------------------------------------------

function ToolStrip({ tools }: { tools: AnalysisDocument["tools"] }) {
  if (!tools?.length) return null;
  const on = tools.filter((t) => t.connected).length;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
      <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Tools {on}/{tools.length}
      </span>
      {tools.map((t) => (
        <span
          key={t.name}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
          style={{ opacity: t.connected ? 1 : 0.55 }}
          title={t.note ?? (t.connected ? "Connected" : "Not connected")}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: t.connected ? "var(--ship)" : "var(--muted-foreground)" }}
            aria-hidden
          />
          {t.name}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 0: snapshot scorecard
// ---------------------------------------------------------------------------

function Scorecard({
  cards, month, series,
}: {
  cards: AnalysisScorecardCard[]; month: string; series: ReturnType<typeof analysisSeries>;
}) {
  return (
    <Section
      icon={<Telescope aria-hidden className="size-4.5" />}
      title="The month in 15 seconds"
      subtitle="Every headline number, with its month over month change"
      right={<div className="hidden text-sm text-muted-foreground sm:block">{monthLabel(month)}</div>}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => {
          const spark = (c.spark ?? []).filter((v): v is number => typeof v === "number");
          const cd = c.available ? cardDelta(c, month, series) : null;
          return (
            <div
              key={c.key}
              className="flex flex-col rounded-lg border p-3.5"
              style={{
                borderColor: "var(--border)",
                borderTopWidth: 2.5,
                borderTopColor: c.available ? "var(--primary)" : "var(--border)",
                backgroundColor: c.available ? "var(--card)" : "var(--muted)",
              }}
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {c.label}
              </div>
              {c.available ? (
                <>
                  <div className="mt-1 flex items-end gap-2">
                    <div className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                      {typeof c.value === "number" ? c.value.toLocaleString("en-US") : c.value}
                      {c.unit ? <span className="ml-0.5 text-sm text-muted-foreground">{c.unit}</span> : null}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Delta delta={toDelta(cd)} />
                    {spark.length > 1 ? <div className="w-16"><Sparkline values={spark} /></div> : null}
                  </div>
                  <div className="mt-1.5 text-[10px] text-muted-foreground">{c.tool}</div>
                </>
              ) : (
                <>
                  <div className="mt-1 text-lg font-semibold text-muted-foreground">n/a</div>
                  <div className="mt-1.5 text-[10px] text-muted-foreground">{c.note ?? "Not connected"}</div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section 1: executive summary
// ---------------------------------------------------------------------------

function ExecutiveSummary({ summary }: { summary: NonNullable<AnalysisDocument["executive_summary"]> }) {
  return (
    <Section icon={<BadgeCheck aria-hidden className="size-4.5" />} title="Executive summary">
      <div className="flex flex-col gap-2">
        {(summary.paragraphs ?? []).map((p, i) => (
          <p key={i} className="text-sm text-foreground">{p}</p>
        ))}
      </div>
      {summary.did?.length || summary.next?.length ? (
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <TwoColList title="What we did" items={summary.did ?? []} />
          <TwoColList title="What is next" items={summary.next ?? []} />
        </div>
      ) : null}
    </Section>
  );
}

function TwoColList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="mb-2 border-b border-border pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-foreground">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 2a: prompt visibility matrix (the centrepiece)
// ---------------------------------------------------------------------------

function PromptMatrix({ matrix }: { matrix: AnalysisDocument["ai_visibility"]["prompt_matrix"] }) {
  const engines = matrix.engines ?? [];
  return (
    <Section
      icon={<Search aria-hidden className="size-4.5" />}
      title="Prompt visibility matrix"
      subtitle="Where you win across the AI answer engines, by buyer prompt"
      right={
        typeof matrix.coverage_pct === "number" ? (
          <span
            className="rounded-md px-2.5 py-1 text-sm font-semibold"
            style={{ color: "var(--primary)", backgroundColor: "var(--primary)", opacity: 1 }}
          >
            <span style={{ color: "var(--primary-foreground)" }}>Coverage {matrix.coverage_pct}%</span>
          </span>
        ) : null
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>Buyer prompt</Th>
              {engines.map((e) => (
                <th key={e} className="border-b border-border px-2 py-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {e}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.prompts.map((p, i) => {
              const byEngine = new Map(p.cells.map((c) => [c.engine, c]));
              return (
                <tr key={i}>
                  <td className="border-b border-border px-3 py-2 align-middle text-sm font-medium text-foreground">
                    {p.prompt}
                  </td>
                  {engines.map((e) => {
                    const cell = byEngine.get(e);
                    const tone = cellTone(cell?.state ?? null);
                    return (
                      <td key={e} className="border-b border-border px-1.5 py-1.5 text-center">
                        <span
                          className="inline-flex min-w-14 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] font-semibold"
                          style={{ color: tone.color, backgroundColor: tone.bg }}
                          title={cell?.state ?? "no data"}
                        >
                          {tone.label}
                          {cell?.change === "new" ? <TrendingUp aria-hidden className="size-3" /> : null}
                          {cell?.change === "lost" ? <TrendingUp aria-hidden className="size-3 rotate-180" /> : null}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <Legend color="var(--ship)" label="Cited" />
        <Legend color="var(--review)" label="Named, not linked" />
        <Legend color="var(--fail)" label="Absent" />
      </div>
    </Section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section 2b: citations + gaps
// ---------------------------------------------------------------------------

function CitationsGaps({ ai }: { ai: AnalysisDocument["ai_visibility"] }) {
  return (
    <Section icon={<Sparkles aria-hidden className="size-4.5" />} title="Citations and priority gaps">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Where you are cited</div>
          <ul className="flex flex-col gap-2 text-sm">
            {(ai.citations ?? []).map((c, i) => (
              <li key={i} className="rounded-md border border-border p-2.5">
                <span className="font-medium text-foreground">{c.engine}</span>
                <span className="text-muted-foreground"> on {`"${c.prompt}"`}</span>
                <p className="mt-1 text-muted-foreground">{c.snippet}</p>
              </li>
            ))}
            {!ai.citations?.length ? <li className="text-sm text-muted-foreground">No citations recorded this month.</li> : null}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Priority gaps</div>
          <ul className="flex flex-col gap-2 text-sm">
            {(ai.gaps ?? []).map((g, i) => (
              <li key={i} className="rounded-md border-l-2 border-border p-2.5" style={{ borderLeftColor: "var(--primary)" }}>
                <span className="font-medium text-foreground">{g.prompt}</span>
                <p className="mt-1 text-muted-foreground">{g.play}</p>
              </li>
            ))}
            {!ai.gaps?.length ? <li className="text-sm text-muted-foreground">No open gaps flagged.</li> : null}
          </ul>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section 2c / 2e / 2f
// ---------------------------------------------------------------------------

function ReferralTraffic({ rows }: { rows: NonNullable<NonNullable<AnalysisDocument["ai_visibility"]["referral_traffic"]>["by_source"]> }) {
  return (
    <Section icon={<Activity aria-hidden className="size-4.5" />} title="AI referral traffic" subtitle="Real humans arriving from AI engines">
      <DataTable>
        <thead><tr><Th>Source</Th><Th num>Sessions</Th><Th num>Engaged</Th><Th num>Conversions</Th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><Td mono>{r.source}</Td><Td num>{r.sessions.toLocaleString("en-US")}</Td><Td num>{r.engaged.toLocaleString("en-US")}</Td><Td num>{r.conversions.toLocaleString("en-US")}</Td></tr>
          ))}
        </tbody>
      </DataTable>
    </Section>
  );
}

function BingIndicator({ bing }: { bing: NonNullable<AnalysisDocument["ai_visibility"]["bing_indicator"]> }) {
  return (
    <Section icon={<Globe aria-hidden className="size-4.5" />} title="Bing as a GEO leading indicator" subtitle="Bing feeds Copilot and ChatGPT search, so index coverage here is your AI pipeline filling">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Impressions" value={bing.impressions} />
        <Tile label="Clicks" value={bing.clicks} />
        <Tile label="Key pages indexed" value={`${bing.indexed}/${bing.key_pages}`} />
      </div>
    </Section>
  );
}

function AiOverview({ rows }: { rows: NonNullable<AnalysisDocument["ai_visibility"]["ai_overview"]> }) {
  return (
    <Section icon={<Layers aria-hidden className="size-4.5" />} title="Google AI Overview presence">
      <DataTable>
        <thead><tr><Th>Keyword</Th><Th>AI Overview</Th><Th>You cited</Th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <Td>{r.keyword}</Td>
              <Td><YesNo value={r.aio_present} /></Td>
              <Td><YesNo value={r.client_cited} good /></Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </Section>
  );
}

function YesNo({ value, good = false }: { value: boolean; good?: boolean }) {
  const color = value ? "var(--ship)" : good ? "var(--fail)" : "var(--muted-foreground)";
  return <span className="font-medium" style={{ color }}>{value ? "Yes" : "No"}</span>;
}

// ---------------------------------------------------------------------------
// Section 3: SEO visibility
// ---------------------------------------------------------------------------

function SeoSection({ seo }: { seo: NonNullable<AnalysisDocument["seo_visibility"]> }) {
  const lh = seo.tech_health?.lighthouse?.scores ?? [];
  return (
    <Section icon={<TrendingUp aria-hidden className="size-4.5" />} title="SEO visibility" subtitle="Google and Bing ground truth, movers first">
      {seo.google ? (
        <>
          <SubHead>Google performance</SubHead>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Clicks" value={seo.google.clicks} prev={seo.google.prev_clicks} />
            <Tile label="Impressions" value={seo.google.impressions} prev={seo.google.prev_impressions} />
            <Tile label="Avg position" value={seo.google.avg_position} prev={seo.google.prev_avg_position} goodUp={false} />
            <Tile label="CTR" value={seo.google.ctr} unit="%" prev={seo.google.prev_ctr} />
          </div>
        </>
      ) : null}

      {seo.striking_distance?.length ? (
        <>
          <SubHead>Striking distance, the quick wins</SubHead>
          <DataTable>
            <thead><tr><Th>Query</Th><Th num>Position</Th><Th num>Impressions</Th><Th>URL</Th></tr></thead>
            <tbody>
              {seo.striking_distance.map((q, i) => (
                <tr key={i}><Td>{q.query}</Td><Td num>{q.position}</Td><Td num>{q.impressions.toLocaleString("en-US")}</Td><Td mono>{q.url}</Td></tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}

      {seo.rankings?.length ? (
        <>
          <SubHead>Rankings, movers first</SubHead>
          <DataTable>
            <thead><tr><Th>Keyword</Th><Th num>Position</Th><Th num>MoM</Th><Th num>Volume</Th><Th>URL</Th></tr></thead>
            <tbody>
              {seo.rankings.map((r, i) => (
                <tr key={i}>
                  <Td>{r.keyword}</Td>
                  <Td num>{r.position}</Td>
                  <Td num><RankDelta delta={r.delta} /></Td>
                  <Td num>{r.volume != null ? r.volume.toLocaleString("en-US") : "-"}</Td>
                  <Td mono>{r.url ?? "-"}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}

      {seo.serp_features?.length ? (
        <>
          <SubHead>SERP feature and AI Overview capture</SubHead>
          <DataTable>
            <thead><tr><Th>Feature</Th><Th num>This month</Th><Th num>Last month</Th></tr></thead>
            <tbody>
              {seo.serp_features.map((f, i) => (
                <tr key={i}><Td>{f.feature}</Td><Td num>{f.owned_this}</Td><Td num>{f.owned_last}</Td></tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}

      {seo.bing ? (
        <>
          <SubHead>Bing performance</SubHead>
          <div className="grid grid-cols-3 gap-3">
            <Tile label="Clicks" value={seo.bing.clicks} />
            <Tile label="Impressions" value={seo.bing.impressions} />
            <Tile label="Avg position" value={seo.bing.avg_position} />
          </div>
        </>
      ) : null}

      {lh.length ? (
        <>
          <SubHead>Technical and GEO health</SubHead>
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            {lh.map((s) => {
              const d = lighthouseScore(s.desktop);
              return (
                <div key={s.category} className="flex flex-col items-center gap-1 text-center">
                  <span className="text-2xl font-semibold tabular-nums" style={{ color: BAND_COLOR[lighthouseBand(d)] }}>
                    {d === null ? "-" : d}
                  </span>
                  <span className="text-xs text-muted-foreground">{s.category}</span>
                </div>
              );
            })}
            {seo.tech_health?.schema_coverage_pct != null ? (
              <div className="flex flex-col items-center gap-1 text-center">
                <span className="text-2xl font-semibold tabular-nums text-foreground">{seo.tech_health.schema_coverage_pct}%</span>
                <span className="text-xs text-muted-foreground">Schema coverage</span>
              </div>
            ) : null}
            {seo.tech_health?.cwv_status ? (
              <div className="flex flex-col items-center gap-1 text-center">
                <span className="text-sm font-semibold text-foreground">{seo.tech_health.cwv_status}</span>
                <span className="text-xs text-muted-foreground">Core Web Vitals</span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </Section>
  );
}

function RankDelta({ delta }: { delta?: number }) {
  if (!delta) return <span className="text-muted-foreground">0</span>;
  const up = delta > 0;
  return <span className="font-medium tabular-nums" style={{ color: up ? "var(--ship)" : "var(--fail)" }}>{up ? "+" : ""}{delta}</span>;
}

// ---------------------------------------------------------------------------
// Section 4: engagement
// ---------------------------------------------------------------------------

function EngagementSection({ engagement }: { engagement: NonNullable<AnalysisDocument["engagement"]> }) {
  return (
    <Section icon={<Gauge aria-hidden className="size-4.5" />} title="Engagement and behaviour" subtitle="Whether the traffic you win actually reads the page">
      {engagement.landing_pages?.length ? (
        <>
          <SubHead>Landing page behaviour</SubHead>
          <DataTable>
            <thead><tr><Th>Page</Th><Th num>Scroll depth</Th><Th>Avg time</Th><Th>Top clicked</Th></tr></thead>
            <tbody>
              {engagement.landing_pages.map((p, i) => (
                <tr key={i}><Td mono>{p.page}</Td><Td num>{p.scroll_pct}%</Td><Td>{p.avg_time}</Td><Td>{p.top_click}</Td></tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}
      {engagement.friction?.length ? (
        <>
          <SubHead>Friction flags</SubHead>
          <DataTable>
            <thead><tr><Th>Page</Th><Th>Problem</Th><Th num>Count</Th><Th num>MoM</Th></tr></thead>
            <tbody>
              {engagement.friction.map((f, i) => (
                <tr key={i}>
                  <Td mono>{f.page}</Td><Td>{f.type}</Td><Td num>{f.count.toLocaleString("en-US")}</Td>
                  <Td num>{f.delta ? <span style={{ color: f.delta > 0 ? "var(--fail)" : "var(--ship)" }}>{f.delta > 0 ? "+" : ""}{f.delta}</span> : "0"}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section 5: outcomes
// ---------------------------------------------------------------------------

function Outcomes({ outcomes }: { outcomes: NonNullable<AnalysisDocument["outcomes"]> }) {
  return (
    <Section icon={<Target aria-hidden className="size-4.5" />} title="Outcomes" subtitle="Visibility to traffic to engagement to business">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Organic sessions" value={outcomes.organic_sessions} prev={outcomes.prev_organic_sessions} />
        {outcomes.engaged_sessions != null ? <Tile label="Engaged sessions" value={outcomes.engaged_sessions} /> : null}
        <Tile label="Conversions, organic" value={outcomes.conversions_organic} />
        {outcomes.conversions_ai != null ? <Tile label="Conversions, AI referral" value={outcomes.conversions_ai} /> : null}
      </div>
      {outcomes.summary ? (
        <div className="mt-4 rounded-lg px-3.5 py-2.5 text-sm" style={{ color: "var(--primary)", backgroundColor: "var(--primary)", opacity: 1 }}>
          <span style={{ color: "var(--primary-foreground)" }}>{outcomes.summary}</span>
        </div>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section 6: plan
// ---------------------------------------------------------------------------

function PlanSection({ plan }: { plan: NonNullable<AnalysisDocument["plan"]> }) {
  return (
    <Section icon={<ListChecks aria-hidden className="size-4.5" />} title="What we did and what is next">
      <div className="grid gap-5 sm:grid-cols-2">
        <TwoColList title="Shipped this month" items={plan.did ?? []} />
        <div>
          <div className="mb-2 border-b border-border pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Next month plan
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-foreground">
            {(plan.next ?? []).map((n, i) => (
              <li key={i}>
                {n.item}
                {n.source ? <span className="ml-1 text-xs" style={{ color: "var(--primary)" }}>{n.source}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function SubHead({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-5 text-sm font-medium text-foreground first:mt-0">{children}</div>;
}

function Tile({
  label, value, unit, prev, goodUp = true,
}: {
  label: string; value: number | string; unit?: string; prev?: number; goodUp?: boolean;
}) {
  const cur = typeof value === "number" ? value : null;
  const delta = cur !== null && typeof prev === "number"
    ? { abs: Math.round((cur - prev) * 100) / 100, pct: prev === 0 ? null : Math.round(((cur - prev) / prev) * 100), prevMonth: "" }
    : null;
  return (
    <div className="rounded-lg border border-border p-3" style={{ borderTopWidth: 2.5, borderTopColor: "var(--primary)" }}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-end gap-2">
        <div className="text-2xl font-semibold leading-none tabular-nums text-foreground">
          {typeof value === "number" ? value.toLocaleString("en-US") : value}
          {unit ? <span className="ml-0.5 text-sm text-muted-foreground">{unit}</span> : null}
        </div>
      </div>
      {delta ? <div className="mt-2"><Delta delta={delta} goodUp={goodUp} /></div> : null}
    </div>
  );
}
