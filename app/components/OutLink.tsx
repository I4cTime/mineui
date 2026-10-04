"use client";

// A link that leaves the app. The webview does not reliably hand
// target="_blank" to the system browser on every platform, so the click goes
// through the allowlisted open_url command (contract §3.15); the href stays
// for the tooltip, copy-link and keyboard semantics.
import { toast } from "@heroui/react";
import { IpcError, isTauri, openUrl } from "@/app/lib/ipc";

interface OutLinkProps {
  href: string;
  className?: string;
  children: React.ReactNode;
}

export default function OutLink({ href, className, children }: OutLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      onClick={(event) => {
        if (!isTauri()) return; // plain browser preview: let the anchor work
        event.preventDefault();
        openUrl(href).catch((error: unknown) => {
          toast.danger(error instanceof IpcError ? error.message : "Could not open the link");
        });
      }}
    >
      {children}
    </a>
  );
}
