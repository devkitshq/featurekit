/**
 * UI Primitives & shadcn Component System for FeatureKit Admin Panel
 */

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
  type HTMLAttributes,
} from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Info,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Re-export official shadcn CLI components
export { Button, buttonVariants } from "@/components/ui/button";
export { Badge, badgeVariants } from "@/components/ui/badge";
export {
  Card as RawCard,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
export { Input } from "@/components/ui/input";
export { Textarea } from "@/components/ui/textarea";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "@/components/ui/table";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from "@/components/ui/dropdown-menu";
export { Separator } from "@/components/ui/separator";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
export { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
export { Skeleton } from "@/components/ui/skeleton";
export {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";

import { Button } from "@/components/ui/button";
import {
  Dialog as ShadcnDialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/* ──────────────────────────────── Card ──────────────────────────────── */

export function Card({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-all overflow-hidden",
        className,
      )}
      {...props}
    >
      {title !== undefined ? (
        <header className="flex items-start justify-between gap-4 border-b border-border/70 px-4 py-3.5 bg-muted/20">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
            {description !== undefined ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? <div className="p-4">{children}</div> : null}
    </div>
  );
}

/* ──────────────────────────────── Select ──────────────────────────────── */

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative w-full">
      <select
        {...rest}
        className={cn(
          "flex h-8 w-full appearance-none rounded-lg border border-input bg-background px-2.5 py-1 text-xs text-foreground shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 pr-8 cursor-pointer",
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-3.5 text-muted-foreground" />
    </div>
  );
}

/* ──────────────────────────────── Field ──────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error != null ? (
        <span className="block text-xs font-medium text-destructive">{error}</span>
      ) : hint !== undefined ? (
        <span className="block text-xs text-muted-foreground/80">{hint}</span>
      ) : null}
    </label>
  );
}

/* ──────────────────────────────── Switch ──────────────────────────────── */

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  tone = "accent",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  tone?: "accent" | "on" | "default";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? tone === "on"
            ? "bg-emerald-600 dark:bg-emerald-500"
            : "bg-primary"
          : "bg-input",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/* ──────────────────────────────── Dialog ──────────────────────────────── */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg" | "xl";
}) {
  const widths = {
    sm: "sm:max-w-sm",
    md: "sm:max-w-lg",
    lg: "sm:max-w-2xl",
    xl: "sm:max-w-4xl",
  };

  return (
    <ShadcnDialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className={cn("p-6 gap-4", widths[width])}>
        {title !== undefined || description !== undefined ? (
          <DialogHeader className="gap-1">
            {title !== undefined ? <DialogTitle className="text-base font-semibold text-foreground">{title}</DialogTitle> : null}
            {description !== undefined ? (
              <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
                {description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
        ) : null}
        {children !== undefined ? <div className="space-y-3.5 py-1">{children}</div> : null}
        {footer !== undefined ? (
          <DialogFooter className="pt-4 border-t border-border flex items-center justify-end gap-2">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </ShadcnDialog>
  );
}

/* ───────────────────────────── Confirm Dialog ────────────────────────── */

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  destructive = true,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onConfirm()).finally(() => {
                setBusy(false);
                onClose();
              });
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-xs text-muted-foreground leading-relaxed">{body}</div>
    </Dialog>
  );
}

/* ──────────────────────────────── Tabs ──────────────────────────────── */

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ id: string; label: string; badge?: ReactNode }>;
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex gap-1 border-b border-border", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          className={cn(
            "-mb-px border-b-2 px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer select-none",
            tab.id === active
              ? "border-primary text-foreground font-semibold"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            {tab.label}
            {tab.badge}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────── States & Alerts ────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn("size-4 animate-spin text-muted-foreground", className)}
      aria-label="Loading"
    />
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body !== undefined ? (
        <p className="max-w-md text-xs text-muted-foreground leading-relaxed">{body}</p>
      ) : null}
      {action !== undefined ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 leading-relaxed font-medium">{children}</div>
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/50 px-3.5 py-2.5 text-xs text-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 leading-relaxed font-medium">{children}</div>
    </div>
  );
}

/* ──────────────────────────────── Toast ──────────────────────────────── */

interface ToastItem {
  id: number;
  tone: "ok" | "error" | "info";
  message: string;
}

const ToastContext = createContext<{
  push: (tone: ToastItem["tone"], message: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(0);

  const push = useCallback((tone: ToastItem["tone"], message: string) => {
    const id = ++next.current;
    setToasts((current) => [...current, { id, tone, message }]);
    setTimeout(
      () => setToasts((current) => current.filter((t) => t.id !== id)),
      tone === "error" ? 7000 : 3500,
    );
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "fk-rise pointer-events-auto flex items-start gap-2.5 rounded-lg border p-3 text-xs shadow-lg transition-all",
              toast.tone === "error"
                ? "border-destructive/40 bg-destructive/15 text-destructive"
                : "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
            )}
          >
            {toast.tone === "error" ? (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <Check className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-words font-medium leading-relaxed">
              {toast.message}
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (context === null) throw new Error("useToast outside ToastProvider");
  return context;
}

/* ───────────────────────────── Copyable Key ──────────────────────────── */

export function CopyableKey({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <code
        id={id}
        className="truncate rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground border border-border/70"
      >
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? (
          <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Copy className="size-3" />
        )}
      </Button>
    </span>
  );
}
