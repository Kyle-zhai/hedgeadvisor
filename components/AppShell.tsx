"use client";

import {
  ChartLineUp,
  ClockCounterClockwise,
  GearSix,
  Graph,
  LinkSimple,
  List,
  Notebook,
  ShieldCheck,
  Stack,
  X,
} from "@phosphor-icons/react";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode } from "react";

type Icon = ComponentType<{ size?: number; weight?: "regular" | "fill"; "aria-hidden"?: boolean }>;

const NAV: { href: string; label: string; icon: Icon }[] = [
  { href: "/protect", label: "Protect", icon: ShieldCheck },
  { href: "/plan", label: "Plan", icon: Notebook },
  { href: "/combo", label: "Combo", icon: Stack },
  { href: "/link", label: "Cross-venue", icon: LinkSimple },
  { href: "/discover", label: "Discover", icon: Graph },
  { href: "/markets", label: "Markets", icon: ChartLineUp },
  { href: "/history", label: "History", icon: ClockCounterClockwise },
  { href: "/settings", label: "Settings", icon: GearSix },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => path.startsWith(href) || (href === "/protect" && path === "/hedge");

  return (
    <div className="app">
      <button className="mobile-menu" type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? "Close navigation" : "Open navigation"}>
        {open ? <X size={20} aria-hidden /> : <List size={20} aria-hidden />}
      </button>
      {open && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <aside className={`sidebar${open ? " is-open" : ""}`}>
        <a className="logo" href="/protect" onClick={() => setOpen(false)}>
          <span className="mark"><ShieldCheck size={16} weight="fill" aria-hidden /></span>
          HedgeAdvisor
        </a>
        <nav aria-label="Primary navigation">
          {NAV.map(({ href, label, icon: NavIcon }) => (
            <a key={href} href={href} className={`navitem${isActive(href) ? " active" : ""}`} onClick={() => setOpen(false)}>
              <NavIcon size={18} aria-hidden />
              {label}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        <div className="foot">
          <span className="status-line"><span className="livedot" /> Live Polymarket + Kalshi data</span>
          <span>We never hold funds or keys.</span>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
