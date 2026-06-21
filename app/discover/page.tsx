import { redirect } from "next/navigation";

// /discover merged into /hedge (2026-06-21). Kept as a redirect so old links resolve.
export default function DiscoverRedirect() {
  redirect("/hedge");
}
