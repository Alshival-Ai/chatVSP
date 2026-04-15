import { type User } from "@/lib/types";
import { toast } from "@/hooks/useToast";
import Button from "@/refresh-components/buttons/Button";
import useSWRMutation from "swr/mutation";
import userMutationFetcher from "@/lib/admin/users/userMutationFetcher";
import { SvgCode } from "@opal/icons";

interface ToggleCodeInterpreterButtonProps {
  user: User;
  mutate: () => void;
  className?: string;
}

export default function ToggleCodeInterpreterButton({
  user,
  mutate,
  className,
}: ToggleCodeInterpreterButtonProps) {
  const isEnabled = user.enable_code_interpreter ?? false;
  const nextEnabled = !isEnabled;
  const actionLabel = nextEnabled ? "enabled" : "disabled";

  const { trigger, isMutating } = useSWRMutation(
    "/api/manage/admin/code-interpreter-access",
    userMutationFetcher,
    {
      onSuccess: () => {
        mutate();
        toast.success(`Code Interpreter ${actionLabel} for ${user.email}.`);
      },
      onError: (errorMsg) =>
        toast.error(`Unable to update Code Interpreter - ${errorMsg.message}`),
    }
  );

  return (
    <Button
      className={className}
      onClick={() => trigger({ user_email: user.email, enabled: nextEnabled })}
      disabled={isMutating}
      leftIcon={SvgCode}
      tertiary
    >
      {isEnabled ? "Disable Code Interpreter" : "Enable Code Interpreter"}
    </Button>
  );
}
