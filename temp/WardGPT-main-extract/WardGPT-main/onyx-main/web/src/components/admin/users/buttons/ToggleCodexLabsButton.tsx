import { type User } from "@/lib/types";
import { toast } from "@/hooks/useToast";
import Button from "@/refresh-components/buttons/Button";
import useSWRMutation from "swr/mutation";
import userMutationFetcher from "@/lib/admin/users/userMutationFetcher";
import { SvgTerminal } from "@opal/icons";

interface ToggleCodexLabsButtonProps {
  user: User;
  mutate: () => void;
  className?: string;
}

export default function ToggleCodexLabsButton({
  user,
  mutate,
  className,
}: ToggleCodexLabsButtonProps) {
  const isEnabled = user.enable_codex_labs ?? false;
  const nextEnabled = !isEnabled;
  const actionLabel = nextEnabled ? "enabled" : "disabled";

  const { trigger, isMutating } = useSWRMutation(
    "/api/manage/admin/codex-labs-access",
    userMutationFetcher,
    {
      onSuccess: () => {
        mutate();
        toast.success(`Codex Labs ${actionLabel} for ${user.email}.`);
      },
      onError: (errorMsg) =>
        toast.error(`Unable to update Codex Labs - ${errorMsg.message}`),
    }
  );

  return (
    <Button
      className={className}
      onClick={() => trigger({ user_email: user.email, enabled: nextEnabled })}
      disabled={isMutating}
      leftIcon={SvgTerminal}
      tertiary
    >
      {isEnabled ? "Disable Codex Labs" : "Enable Codex Labs"}
    </Button>
  );
}
