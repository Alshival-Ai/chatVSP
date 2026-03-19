import React from "react";
import Image from "next/image";

interface ErrorPageLayoutProps {
  children: React.ReactNode;
}

export default function ErrorPageLayout({ children }: ErrorPageLayoutProps) {
  return (
    <div className="flex flex-col items-center justify-center w-full h-screen gap-4">
      <Image
        src="/logo.png"
        alt="chatVSP logo"
        width={120}
        height={120}
        className="object-contain"
      />
      <div className="max-w-[40rem] w-full border bg-background-neutral-00 shadow-02 rounded-16 p-6 flex flex-col gap-4">
        {children}
      </div>
    </div>
  );
}
