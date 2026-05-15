import { redirect } from "next/navigation";
import { withBasePath } from "@/lib/shared/base-path";

export default function AdminPage() {
  redirect(withBasePath("/desktop"));
}
