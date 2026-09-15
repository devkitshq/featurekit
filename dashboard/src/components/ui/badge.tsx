import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80 shadow-xs",
        secondary:
          "bg-secondary text-secondary-foreground border-border [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/15 text-destructive border-transparent dark:bg-destructive/20",
        danger:
          "bg-destructive/15 text-destructive border-transparent dark:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        neutral:
          "border-border bg-secondary text-muted-foreground",
        accent:
          "border-transparent bg-indigo-500/15 text-indigo-500 dark:text-indigo-400 font-semibold",
        on: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-semibold",
        off: "border-border bg-secondary/80 text-muted-foreground",
        warn: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export type BadgeTone = "neutral" | "accent" | "on" | "off" | "danger" | "warn" | "default" | "secondary" | "destructive" | "outline"

export interface BadgeProps
  extends useRender.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {
  tone?: BadgeTone
}

function Badge({
  className,
  variant,
  tone,
  render,
  ...props
}: BadgeProps) {
  const chosenVariant = tone ?? variant ?? "default"

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant: chosenVariant as VariantProps<typeof badgeVariants>["variant"] }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant: chosenVariant,
    },
  })
}

export { Badge, badgeVariants }
