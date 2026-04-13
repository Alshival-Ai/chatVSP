import { Content } from "@opal/layouts";
import Text from "@/refresh-components/texts/Text";

export default function CodexLabsPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <Content
        sizePreset="main-ui"
        variant="section"
        title="Codex Labs"
        description="The first integration slice is installed and gated behind per-user access."
      />

      <div className="rounded-12 border border-border-02 bg-background-000 p-6">
        <Text as="p" mainUiBody>
          This workspace route is active. The next slice will port the WardGPT
          terminal session manager and file browser on top of the existing
          Onyx build stack rather than merging the full fork.
        </Text>
      </div>
    </div>
  );
}
