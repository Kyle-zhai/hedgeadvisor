import { redirect } from "next/navigation";

// All hedge surfaces merged into the single /hedge surface (2026-06-21).
export default function Home() {
  redirect("/hedge");
}
