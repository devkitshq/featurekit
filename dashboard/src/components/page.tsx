/** The page frame: a title row, and the space beneath it. */

import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function Page({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          {description !== undefined ? (
            <p className="mt-0.5 text-xs text-muted">{description}</p>
          ) : null}
        </div>
        {actions !== undefined ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </header>
      <div className={cn("space-y-4", className)}>{children}</div>
    </div>
  );
}
