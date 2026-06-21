import { redirect } from "next/navigation";

// Hedge merged into Protect (2026-06-18): Protect is the single loss-minimization surface.
// The old Hedge UI lives at /hedge (unlisted) until its advanced bits (held-position cost basis,
// Kelly sizing, cross-event ladder, LLM explanations) are folded into Protect.
export default function Home() {
  redirect("/protect");
}
