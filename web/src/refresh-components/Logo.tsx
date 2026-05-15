"use client";

import { useSettingsContext } from "@/providers/SettingsProvider";
import Image from "next/image";
import { LOGO_FOLDED_SIZE_PX } from "@/lib/constants";
import { cn } from "@/lib/utils";
import Truncated from "@/refresh-components/texts/Truncated";
import { useMemo } from "react";

export interface LogoProps {
  folded?: boolean;
  size?: number;
  className?: string;
}

const DEFAULT_APP_NAME = "chatVSP";

export default function Logo({ folded, size, className }: LogoProps) {
  const foldedSize = size ?? LOGO_FOLDED_SIZE_PX;
  const settings = useSettingsContext();
  const logoDisplayStyle = settings.enterpriseSettings?.logo_display_style;
  const applicationName =
    settings.enterpriseSettings?.application_name || DEFAULT_APP_NAME;

  const logo = useMemo(
    () =>
      settings.enterpriseSettings?.use_custom_logo ? (
        <div
          className={cn(
            "aspect-square rounded-full overflow-hidden relative flex-shrink-0",
            className
          )}
          style={{ height: foldedSize, width: foldedSize }}
        >
          <Image
            alt="Logo"
            src="/api/enterprise-settings/logo"
            fill
            className="object-cover object-center"
            sizes={`${foldedSize}px`}
          />
        </div>
      ) : (
        <Image
          alt={`${applicationName} logo`}
          src="/logo.png"
          width={foldedSize}
          height={foldedSize}
          className={cn("object-contain flex-shrink-0", className)}
        />
      ),
    [
      applicationName,
      className,
      foldedSize,
      settings.enterpriseSettings?.use_custom_logo,
    ]
  );

  const renderLogoContent = (opts: {
    includeLogo: boolean;
    includeName: boolean;
  }) => {
    return (
      <div className="flex min-w-0 items-center gap-2">
        {opts.includeLogo && logo}
        {!folded && opts.includeName && (
          <div className="flex min-w-0 flex-1">
            <Truncated headingH3>{applicationName}</Truncated>
          </div>
        )}
      </div>
    );
  };

  // Handle "logo_only" display style
  if (logoDisplayStyle === "logo_only") {
    return renderLogoContent({ includeLogo: true, includeName: false });
  }

  // Handle "name_only" display style
  if (logoDisplayStyle === "name_only") {
    return renderLogoContent({ includeLogo: false, includeName: true });
  }

  // Handle "logo_and_name" or default behavior
  return renderLogoContent({ includeLogo: true, includeName: true });
}
