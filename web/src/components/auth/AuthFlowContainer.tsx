import Link from "next/link";
import { OnyxIcon } from "../icons/icons";
import Text from "@/refresh-components/texts/Text";

export default function AuthFlowContainer({
  children,
  authState,
  footerContent,
}: {
  children: React.ReactNode;
  authState?: "signup" | "login" | "join";
  footerContent?: React.ReactNode;
}) {
  return (
    <div className="auth-flow p-4 flex flex-col items-center justify-center min-h-screen bg-background">
      <div className="auth-orb auth-orb-left" aria-hidden="true" />
      <div className="auth-orb auth-orb-right" aria-hidden="true" />
      <div className="auth-grid" aria-hidden="true" />
      <div className="auth-panel w-full max-w-md flex items-start flex-col bg-background-tint-00 rounded-16 shadow-lg shadow-02 p-6">
        <div className="flex items-center gap-3">
          <div className="auth-logo-badge">
            <OnyxIcon size={36} className="text-theme-blue-05" />
          </div>
          <div className="flex flex-col">
            <Text as="p" headingH3 text05 className="tracking-tight">
              ChatVSP
            </Text>
            <Text as="p" text03 mainUiMuted>
              VSP-powered AI workspace
            </Text>
          </div>
        </div>
        <div className="w-full mt-6">{children}</div>
      </div>
      {authState === "login" && footerContent && (
        <div className="text-sm mt-6 text-center w-full text-text-03 mainUiBody mx-auto">
          {footerContent}
        </div>
      )}
      {authState === "signup" && (
        <div className="text-sm mt-6 text-center w-full text-text-03 mainUiBody mx-auto">
          Already have an account?{" "}
          <Link
            href="/auth/login"
            className="text-text-05 mainUiAction underline transition-colors duration-200"
          >
            Sign In
          </Link>
        </div>
      )}
    </div>
  );
}
