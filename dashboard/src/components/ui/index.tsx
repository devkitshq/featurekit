/**
 * The primitives.
 *
 * Written here rather than pulled from a component library, for the same reason
 * the control plane has no HTTP framework: there are a dozen of them, they are
 * each twenty lines, and owning them means the dashboard has no runtime
 * dependency that can break its own styling in a minor release.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AlertTriangle, Check, Copy, Info, Loader2, X } from "lucide-react";
import { cn } from "../../lib/utils";

/* ─────────────────────────────── button ────────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md" | "icon";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 border-transparent",
  secondary: "bg-raised text-ink border-border hover:border-border-strong",
  ghost: "bg-transparent text-muted border-transparent hover:bg-raised hover:text-ink",
  danger: "bg-danger text-white border-transparent hover:brightness-110",
  subtle: "bg-transparent text-muted border-border hover:text-ink hover:border-border-strong",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  icon: "h-8 w-8 justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      // A button that is busy must not be clickable twice: the second click is
      // the duplicate write nobody meant to make.
      disabled={disabled === true || loading}
      className={cn(
        "inline-flex items-center rounded-md border font-medium transition",
        "disabled:opacity-50 disabled:pointer-events-none",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ─────────────────────────────── inputs ────────────────────────────── */

const FIELD_BASE =
  "w-full rounded-md border border-border bg-canvas px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(FIELD_BASE, className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(FIELD_BASE, "font-mono text-xs", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(FIELD_BASE, "pr-8", className)}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error != null ? (
        <span className="block text-xs text-danger">{error}</span>
      ) : hint !== undefined ? (
        <span className="block text-xs text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

/* ─────────────────────────────── switch ────────────────────────────── */

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
  tone?: "accent" | "on";
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
        "relative h-5 w-9 shrink-0 rounded-full border transition disabled:opacity-50",
        checked
          ? tone === "on"
            ? "border-on bg-on/80"
            : "border-accent bg-accent"
          : "border-border-strong bg-raised",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full bg-white transition-all",
          checked ? "left-4.5" : "left-0.5",
        )}
      />
    </button>
  );
}

/* ─────────────────────────────── badges ────────────────────────────── */

type BadgeTone = "neutral" | "accent" | "on" | "off" | "danger" | "warn";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-raised text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  on: "bg-on-soft text-on border-transparent",
  off: "bg-raised text-faint border-border",
  danger: "bg-danger-soft text-danger border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  title,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ──────────────────────────────── card ─────────────────────────────── */

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-card border border-border bg-surface", className)}>
      {title !== undefined ? (
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description !== undefined ? (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            ) : null}
          </div>
          {actions !== undefined ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? <div className="p-4">{children}</div> : null}
    </section>
  );
}

/* ─────────────────────────────── dialog ────────────────────────────── */

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
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl" };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh]">
      {/* Click-away closes; a click inside must not. */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "fk-rise relative w-full rounded-card border border-border bg-surface shadow-2xl",
          widths[width],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {description !== undefined ? (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        {children !== undefined ? <div className="space-y-3 px-4 py-4">{children}</div> : null}
        {footer !== undefined ? (
          <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A confirmation that names its target.
 *
 * "Are you sure?" is not a confirmation — it asks about nothing. Every
 * destructive path in this dashboard goes through here with the thing it is
 * about to do written out.
 */
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
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onConfirm()).finally(() => {
                setBusy(false);
                onClose();
              });
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{body}</div>
    </Dialog>
  );
}

/* ──────────────────────────────── tabs ─────────────────────────────── */

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; badge?: ReactNode }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition",
            tab.id === active
              ? "border-accent text-ink"
              : "border-transparent text-muted hover:text-ink",
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

/* ──────────────────────────── states, toasts ───────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted", className)} aria-label="Loading" />;
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
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {body !== undefined ? <p className="max-w-md text-xs text-muted">{body}</p> : null}
      {action !== undefined ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-raised px-3 py-2 text-xs text-muted">
      <Info className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface Toast {
  id: number;
  tone: "ok" | "error";
  message: string;
}

const ToastContext = createContext<{
  push: (tone: Toast["tone"], message: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = ++next.current;
    setToasts((current) => [...current, { id, tone, message }]);
    // Errors stay longer: they are read, not glanced at.
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "fk-rise pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg",
              toast.tone === "error"
                ? "border-danger/40 bg-danger-soft text-danger"
                : "border-on/40 bg-on-soft text-on",
            )}
          >
            {toast.tone === "error" ? (
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
            ) : (
              <Check className="mt-px size-3.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">{toast.message}</span>
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

/** A monospace key with a copy button — the thing people take from this UI. */
export function CopyableKey({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <code
        id={id}
        className="truncate rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
      >
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="size-3.5 text-on" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  );
}
