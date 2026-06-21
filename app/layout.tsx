import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "HedgeAdvisor — honest hedge recommendations for Polymarket",
  description:
    "Enter a Polymarket position you hold. HedgeAdvisor finds a correlated hedge, prices it at the real executable cost (not the midpoint), and tells you honestly whether it's worth it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
