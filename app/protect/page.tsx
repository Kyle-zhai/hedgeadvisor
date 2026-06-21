import { redirect } from "next/navigation";

// /protect merged into /hedge (2026-06-21). Kept as a redirect so old links resolve.
export default function ProtectRedirect() {
  redirect("/hedge");
}
