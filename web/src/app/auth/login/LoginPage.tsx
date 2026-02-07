"use client";

import { AuthTypeMetadata } from "@/lib/userSS";
import LoginText from "@/app/auth/login/LoginText";
import SignInButton from "@/app/auth/login/SignInButton";
import EmailPasswordForm from "./EmailPasswordForm";
import { AuthType } from "@/lib/constants";
import { useSendAuthRequiredMessage } from "@/lib/extension/utils";
import Text from "@/refresh-components/texts/Text";

interface LoginPageProps {
  authUrl: string | null;
  authTypeMetadata: AuthTypeMetadata | null;
  nextUrl: string | null;
  hidePageRedirect?: boolean;
  verified?: boolean;
  isFirstUser?: boolean;
}

export default function LoginPage(props: LoginPageProps) {
  const { authUrl, authTypeMetadata, nextUrl, isFirstUser } = props;
  useSendAuthRequiredMessage();

  // Honor any existing nextUrl; only default to new team flow for first users with no nextUrl
  const effectiveNextUrl =
    nextUrl ?? (isFirstUser ? "/app?new_team=true" : null);

  return (
    <div className="flex flex-col w-full justify-center">
      {authUrl &&
        authTypeMetadata &&
        authTypeMetadata.authType !== AuthType.CLOUD &&
        // basic auth is handled below w/ the EmailPasswordForm
        authTypeMetadata.authType !== AuthType.BASIC && (
          <div className="flex flex-col w-full gap-4">
            <LoginText />
            <SignInButton
              authorizeUrl={authUrl}
              authType={authTypeMetadata?.authType}
            />
          </div>
        )}

      {authTypeMetadata?.authType === AuthType.CLOUD && (
        <div className="w-full justify-center flex flex-col gap-6">
          <LoginText />
          {authUrl && authTypeMetadata && (
            <>
              <SignInButton
                authorizeUrl={authUrl}
                authType={authTypeMetadata?.authType}
              />
              <div className="flex flex-row items-center w-full gap-2">
                <div className="flex-1 border-t border-text-01" />
                <Text as="p" text03 mainUiMuted>
                  or
                </Text>
                <div className="flex-1 border-t border-text-01" />
              </div>
            </>
          )}
          <EmailPasswordForm shouldVerify={true} nextUrl={effectiveNextUrl} />
        </div>
      )}

      {authTypeMetadata?.authType === AuthType.BASIC && (
        <div className="flex flex-col w-full gap-6">
          <LoginText />

          <EmailPasswordForm nextUrl={effectiveNextUrl} />
        </div>
      )}
    </div>
  );
}
