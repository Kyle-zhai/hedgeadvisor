"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const INK_3 = "#747b81";
const GRID = "#e4e6e1";
const BLUE = "#285cc4";
const GREEN = "#087345";
const RED = "#bc3024";
const AMBER = "#956800";

type Point = Record<string, number | string>;

function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

function MoneyTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: number; color?: string }[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {payload.map((item, i) => <div key={`${item.name}-${i}`} style={{ color: item.color }}>{item.name}: ${Number(item.value).toFixed(2)}</div>)}
    </div>
  );
}

export function PayoffChart({ data, primaryLabel = "Protected", comparisonLabel = "Unprotected" }: { data: Point[]; primaryLabel?: string; comparisonLabel?: string }) {
  const mounted = useMounted();
  if (!mounted) return <div className="chart-frame" aria-hidden="true" />;
  return (
    <div className="chart-frame">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 10, right: 22, left: 2, bottom: 5 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="probability" tick={{ fill: INK_3, fontSize: 10 }} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={{ fill: INK_3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
          <Tooltip content={<MoneyTooltip />} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 10, color: INK_3 }} />
          <ReferenceLine y={0} stroke="#9ba09c" />
          <Line name={comparisonLabel} type="linear" dataKey="unprotected" stroke="#8b9194" strokeWidth={2} dot={false} />
          <Line name={primaryLabel} type="monotone" dataKey="protected" stroke={BLUE} strokeWidth={2.4} strokeDasharray="6 4" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ScenarioBarChart({ data, format = "money" }: { data: { name: string; value: number }[]; format?: "money" | "percent" }) {
  const mounted = useMounted();
  if (!mounted) return <div className="chart-frame compact" aria-hidden="true" />;
  return (
    <div className="chart-frame compact">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 28, bottom: 2 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={{ fill: INK_3, fontSize: 10 }} axisLine={{ stroke: GRID }} tickFormatter={(v) => format === "money" ? `$${v}` : `${v}%`} />
          <YAxis type="category" dataKey="name" width={88} tick={{ fill: INK_3, fontSize: 10 }} tickLine={false} axisLine={false} />
          {format === "money" ? <Tooltip content={<MoneyTooltip />} /> : <Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} />}
          <ReferenceLine x={0} stroke="#9ba09c" />
          <Bar dataKey="value" name="P&L" radius={[0, 2, 2, 0]}>
            {data.map((entry, index) => <Cell key={index} fill={entry.value >= 0 ? GREEN : RED} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendChart({ data, dataKey = "value", color = BLUE, label = "Value" }: { data: Point[]; dataKey?: string; color?: string; label?: string }) {
  const mounted = useMounted();
  if (!mounted) return <div className="chart-frame compact" aria-hidden="true" />;
  return (
    <div className="chart-frame compact">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 2 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: INK_3, fontSize: 9 }} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={{ fill: INK_3, fontSize: 9 }} tickLine={false} axisLine={false} width={42} />
          <Tooltip content={<MoneyTooltip />} />
          <Line name={label} type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryBarChart({ data }: { data: { name: string; value: number }[] }) {
  const mounted = useMounted();
  if (!mounted) return <div className="chart-frame compact" aria-hidden="true" />;
  return (
    <div className="chart-frame compact">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 20, bottom: 2 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={{ fill: INK_3, fontSize: 9 }} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis type="category" dataKey="name" width={78} tick={{ fill: INK_3, fontSize: 9 }} tickLine={false} axisLine={false} />
          <Tooltip />
          <Bar dataKey="value" name="24h volume" fill={BLUE} radius={[0, 2, 2, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MarketScatter({ data }: { data: { liquidity: number; spread: number; name: string }[] }) {
  const mounted = useMounted();
  if (!mounted) return <div className="chart-frame compact" aria-hidden="true" />;
  return (
    <div className="chart-frame compact">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ScatterChart margin={{ top: 8, right: 16, left: 2, bottom: 6 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis type="number" dataKey="liquidity" name="Liquidity" tick={{ fill: INK_3, fontSize: 9 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
          <YAxis type="number" dataKey="spread" name="Spread" unit="¢" tick={{ fill: INK_3, fontSize: 9 }} width={38} />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} />
          <Scatter data={data} fill={GREEN}>
            {data.map((d, i) => <Cell key={i} fill={d.spread <= 2 ? GREEN : d.spread <= 4 ? AMBER : RED} />)}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
