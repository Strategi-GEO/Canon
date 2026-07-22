"use client";

/**
 * The Reports tab charts, hand-rolled as inline SVG because the app ships no charting library
 * and the dataviz rules want precise marks. Every mark carries the app's one accent (--primary)
 * on a muted track; every label wears a text token, never the data colour; deltas carry a green
 * or red status colour AND an arrow, so direction never rests on hue alone. Both themes come for
 * free because the marks reference CSS variables that the light and dark blocks in globals.css
 * already define.
 */
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { compact, monthShort, type Delta as DeltaValue } from "@/lib/reports";

// ---------------------------------------------------------------------------
// Delta pill
// ---------------------------------------------------------------------------

/**
 * A signed month-over-month change: "+76 (+78%)". Green when the change is in the good
 * direction, red against it, muted when flat. `goodUp` is true for every metric here (more
 * mentions, backlinks and referring domains are all good), so it defaults that way.
 */
export function Delta({
  delta,
  goodUp = true,
  className,
}: {
  delta: DeltaValue;
  goodUp?: boolean;
  className?: string;
}) {
  if (delta === null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>no prior month</span>
    );
  }
  const { abs, pct } = delta;
  const up = abs > 0;
  const flat = abs === 0;
  const good = flat ? null : up === goodUp;
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  const color = good === null ? "var(--muted-foreground)" : good ? "var(--ship)" : "var(--fail)";
  const sign = abs > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        className,
      )}
      style={{
        color,
        backgroundColor:
          good === null
            ? "var(--muted)"
            : good
              ? "var(--ship-bg)"
              : "var(--fail-bg)",
      }}
    >
      <Icon aria-hidden style={{ width: 13, height: 13 }} />
      {sign}
      {abs.toLocaleString("en-US")}
      {pct !== null ? ` (${sign}${pct}%)` : ""}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Engine bars: one horizontal bar per engine, value + delta at the end
// ---------------------------------------------------------------------------

export type EngineRow = { label: string; value: number; delta: DeltaValue };

export function EngineBars({ rows }: { rows: EngineRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const pct = Math.max(2, Math.round((row.value / max) * 100));
        return (
          <div key={row.label} className="flex items-center gap-3">
            <div className="w-20 shrink-0 text-sm text-foreground">{row.label}</div>
            <div
              className="group relative h-3 flex-1 overflow-hidden rounded-full"
              style={{ backgroundColor: "var(--muted)" }}
              title={`${row.label}: ${row.value.toLocaleString("en-US")}`}
            >
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${pct}%`, backgroundColor: "var(--primary)" }}
              />
            </div>
            <div className="flex w-28 shrink-0 items-center justify-end gap-2">
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {row.value.toLocaleString("en-US")}
              </span>
              <MiniDelta delta={row.delta} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The compact per-engine change: just the signed number in a status colour with its arrow. */
function MiniDelta({ delta }: { delta: DeltaValue }) {
  if (delta === null || delta.abs === 0) {
    return <span className="w-10 text-right text-xs text-muted-foreground">{delta ? "0" : "-"}</span>;
  }
  const up = delta.abs > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className="inline-flex w-10 items-center justify-end gap-0.5 text-xs font-medium tabular-nums"
      style={{ color: up ? "var(--ship)" : "var(--fail)" }}
    >
      <Icon aria-hidden style={{ width: 11, height: 11 }} />
      {up ? "+" : ""}
      {delta.abs.toLocaleString("en-US")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sparkline: a tiny trend for a stat tile
// ---------------------------------------------------------------------------

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const w = 120;
  const h = 34;
  const pad = 3;
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => ({
    x: pad + i * step,
    y: h - pad - ((v - min) / span) * (h - pad * 2),
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      className={className}
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      preserveAspectRatio="none"
      aria-hidden
    >
      {values.length > 1 ? (
        <path d={line} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.55} />
      ) : null}
      <circle cx={last.x} cy={last.y} r={3} fill="var(--primary)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Trend line: the all-months chart, with a crosshair + tooltip
// ---------------------------------------------------------------------------

export type TrendPoint = { month: string; label: string; value: number | null };

export function TrendChart({
  points,
  unit = "",
  height = 240,
}: {
  points: TrendPoint[];
  unit?: string;
  height?: number;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const withValue = points.filter((p) => p.value !== null) as { month: string; label: string; value: number }[];

  if (withValue.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No history yet. The line fills in as months are generated.
      </div>
    );
  }

  const W = 760;
  const H = height;
  const pad = { top: 18, right: 20, bottom: 30, left: 44 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const values = withValue.map((p) => p.value);
  const maxV = Math.max(...values);
  const niceMax = niceCeil(maxV);
  const n = withValue.length;
  const xAt = (i: number) => pad.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => pad.top + innerH - (v / (niceMax || 1)) * innerH;

  const pts = withValue.map((p, i) => ({ x: xAt(i), y: yAt(p.value), ...p }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${(pad.top + innerH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(pad.top + innerH).toFixed(1)} Z`;

  const ticks = [0, niceMax / 2, niceMax];
  const active = hover !== null && hover >= 0 && hover < pts.length ? pts[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].x - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHover(best);
  }

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="AI mentions over time"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={pad.left - 8}
              y={yAt(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
              className="tabular-nums"
            >
              {compact(Math.round(t))}
            </text>
          </g>
        ))}

        {/* area + line */}
        {n > 1 ? <path d={area} fill="var(--primary)" opacity={0.1} /> : null}
        {n > 1 ? (
          <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ) : null}

        {/* crosshair */}
        {active ? (
          <line x1={active.x} x2={active.x} y1={pad.top} y2={pad.top + innerH} stroke="var(--border)" strokeWidth={1} />
        ) : null}

        {/* dots: end dot always, all dots when few, active dot lifted */}
        {pts.map((p, i) => {
          const show = n <= 8 || i === pts.length - 1 || i === hover;
          if (!show) return null;
          const r = i === hover ? 5 : 4;
          return (
            <circle
              key={p.month}
              cx={p.x}
              cy={p.y}
              r={r}
              fill="var(--primary)"
              stroke="var(--card)"
              strokeWidth={2}
            />
          );
        })}

        {/* x labels */}
        {pts.map((p, i) => {
          const show = n <= 8 || i % Math.ceil(n / 8) === 0 || i === pts.length - 1;
          if (!show) return null;
          return (
            <text
              key={p.month}
              x={p.x}
              y={H - 10}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {monthShort(p.month)}
            </text>
          );
        })}
      </svg>

      {active ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: `${(active.x / W) * 100}%`, top: 4 }}
        >
          <div className="font-semibold tabular-nums text-popover-foreground">
            {active.value.toLocaleString("en-US")}
            {unit ? ` ${unit}` : ""}
          </div>
          <div className="text-muted-foreground">{active.label}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Round a max up to a clean axis top: 174 -> 200, 42 -> 50, 8 -> 10. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}
