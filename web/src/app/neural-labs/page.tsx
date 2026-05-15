import { redirect } from "next/navigation";
import type { Route } from "next";
import { NEURAL_LABS_DESKTOP_URL } from "@/lib/constants";

function normalizeNeuralLabsDesktopUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/desktop";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export default function NeuralLabsPage() {
  const targetUrl = normalizeNeuralLabsDesktopUrl(NEURAL_LABS_DESKTOP_URL);

  if (!targetUrl) {
    redirect("/app");
  }

  redirect(targetUrl as Route);
}
