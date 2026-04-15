import { type User } from "@/lib/types";
import { toast } from "@/hooks/useToast";
import Button from "@/refresh-components/buttons/Button";
import useSWRMutation from "swr/mutation";
import userMutationFetcher from "@/lib/admin/users/userMutationFetcher";
import { SvgDevKit } from "@opal/icons";

interface ToggleOnyxCraftButtonProps {
  user: User;
  mutate: () => void;
  className?: string;
}

export default function ToggleOnyxCraftButton({
  user,
  mutate,
  className,
}: ToggleOnyxCraftButtonProps) {
  const isEnabled = user.enable_onyx_craft ?? false;
  const nextEnabled = !isEnabled;
  const actionLabel = nextEnabled ? "enabled" : "disabled";

  const { trigger, isMutating } = useSWRMutation(
    "/api/manage/admin/onyx-craft-access",
    userMutationFetcher,
    {
      onSuccess: () => {
        mutate();
        toast.success(`Craft ${actionLabel} for ${user.email}.`);
      },
      onError: (errorMsg) =>
        toast.error(`Unable to update Craft access - ${errorMsg.message}`),
    }
  );

  return (
    <Button
      className={className}
      onClick={() => trigger({ user_email: user.email, enabled: nextEnabled })}
      disabled={isMutating}
      leftIcon={SvgDevKit}
      tertiary
    >
      {isEnabled ? "Disable Craft" : "Enable Craft"}
    </Button>
  );
}
