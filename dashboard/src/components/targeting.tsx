/**
 * The targeting editor.
 *
 * The order on screen is the evaluation order, and the page says so, because
 * the single most common flag misconfiguration is a rule that never fires
 * because something above it already matched:
 *
 *   prerequisites → individual targets → rules, in order → the default
 *
 * A rule serves **either** one variation **or** a rollout, never both — the
 * database has a constraint saying so, and here it is a radio rather than a
 * validation error after the fact.
 */

import { ChevronDown, ChevronUp, Plus, Trash2, Users } from "lucide-react";
import type { Clause, FlagDefinition, FlagTarget, Rule, Segment } from "../lib/api";
import { fromPercent, toPercent } from "../lib/api";
import {
  OPERATORS,
  cn,
  operatorInputKind,
  parseValue,
  variationLabel,
} from "../lib/utils";
import { Badge, Button, Input, Select } from "./ui";

export interface TargetingValue {
  rules: Rule[];
  targets: FlagTarget[];
  prerequisites: Array<{ flagKey: string; variation: number }>;
  fallthroughVariation?: number;
  fallthroughRollout?: Rule["rollout"];
  offVariation: number | null;
}

export function TargetingEditor({
  flag,
  value,
  onChange,
  segments,
  otherFlags,
  disabled,
}: {
  flag: FlagDefinition;
  value: TargetingValue;
  onChange: (next: TargetingValue) => void;
  segments: Segment[];
  otherFlags: Array<{ key: string; variations: FlagDefinition["variations"] }>;
  disabled: boolean;
}) {
  const patch = (next: Partial<TargetingValue>) => onChange({ ...value, ...next });

  return (
    <div className="space-y-4">
      <Section
        step="1"
        title="Prerequisites"
        hint="Checked first. If any prerequisite flag does not serve its required variation, this flag immediately serves its off variation."
      >
        {value.prerequisites.length === 0 ? (
          <Empty>No prerequisites configured.</Empty>
        ) : (
          <div className="space-y-2">
            {value.prerequisites.map((prerequisite, index) => {
              const target = otherFlags.find((entry) => entry.key === prerequisite.flagKey);
              return (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <Select
                    disabled={disabled}
                    className="w-56"
                    value={prerequisite.flagKey}
                    onChange={(event) =>
                      patch({
                        prerequisites: value.prerequisites.map((entry, at) =>
                          at === index ? { ...entry, flagKey: event.target.value } : entry,
                        ),
                      })
                    }
                  >
                    {otherFlags.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.key}
                      </option>
                    ))}
                  </Select>
                  <span className="text-xs text-muted-foreground">serves</span>
                  <Select
                    disabled={disabled}
                    className="w-40"
                    value={String(prerequisite.variation)}
                    onChange={(event) =>
                      patch({
                        prerequisites: value.prerequisites.map((entry, at) =>
                          at === index ? { ...entry, variation: Number(event.target.value) } : entry,
                        ),
                      })
                    }
                  >
                    {(target?.variations ?? []).map((variation) => (
                      <option key={variation.idx} value={variation.idx}>
                        {variationLabel(variation)}
                      </option>
                    ))}
                  </Select>
                  <RemoveButton
                    disabled={disabled}
                    label="Remove prerequisite"
                    onClick={() =>
                      patch({ prerequisites: value.prerequisites.filter((_, at) => at !== index) })
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
        {otherFlags.length > 0 ? (
          <AddButton
            disabled={disabled}
            label="Add prerequisite"
            onClick={() =>
              patch({
                prerequisites: [
                  ...value.prerequisites,
                  { flagKey: otherFlags[0]!.key, variation: 0 },
                ],
              })
            }
          />
        ) : null}
      </Section>

      <Section
        step="2"
        title="Individual targets"
        hint="Directly assign specific users or entities to a variation before rules are evaluated."
      >
        {value.targets.length === 0 ? (
          <Empty>No individual targets configured.</Empty>
        ) : (
          <div className="space-y-3">
            {value.targets.map((target, index) => (
              <div key={index} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">serve</span>
                  <Select
                    disabled={disabled}
                    className="w-40"
                    value={String(target.variation)}
                    onChange={(event) =>
                      patch({
                        targets: value.targets.map((entry, at) =>
                          at === index ? { ...entry, variation: Number(event.target.value) } : entry,
                        ),
                      })
                    }
                  >
                    {flag.variations.map((variation) => (
                      <option key={variation.idx} value={variation.idx}>
                        {variationLabel(variation, flag.kind)}
                      </option>
                    ))}
                  </Select>
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    disabled={disabled}
                    className="w-24"
                    value={target.contextKind}
                    onChange={(event) =>
                      patch({
                        targets: value.targets.map((entry, at) =>
                          at === index ? { ...entry, contextKind: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <Badge tone="neutral">{target.keys.length} keys</Badge>
                  <div className="ml-auto">
                    <RemoveButton
                      disabled={disabled}
                      label="Remove target list"
                      onClick={() =>
                        patch({ targets: value.targets.filter((_, at) => at !== index) })
                      }
                    />
                  </div>
                </div>
                <textarea
                  disabled={disabled}
                  rows={3}
                  value={target.keys.join("\n")}
                  onChange={(event) =>
                    patch({
                      targets: value.targets.map((entry, at) =>
                        at === index
                          ? {
                              ...entry,
                              keys: event.target.value
                                .split(/[\n,]/)
                                .map((key) => key.trim())
                                .filter((key) => key.length > 0),
                            }
                          : entry,
                      ),
                    })
                  }
                  placeholder="one context key per line"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            ))}
          </div>
        )}
        <AddButton
          disabled={disabled}
          label="Add target list"
          onClick={() =>
            patch({
              targets: [...value.targets, { contextKind: "user", variation: 0, keys: [] }],
            })
          }
        />
      </Section>

      <Section
        step="3"
        title="Rules"
        hint="Evaluated in order from top to bottom. The first rule whose conditions all match determines the variation."
      >
        {value.rules.length === 0 ? (
          <Empty>No custom rules defined. All traffic falls through to the default below.</Empty>
        ) : (
          <div className="space-y-3">
            {value.rules.map((rule, index) => (
              <RuleCard
                key={index}
                index={index}
                total={value.rules.length}
                rule={rule}
                flag={flag}
                segments={segments}
                disabled={disabled}
                onChange={(next) =>
                  patch({ rules: value.rules.map((entry, at) => (at === index ? next : entry)) })
                }
                onRemove={() => patch({ rules: value.rules.filter((_, at) => at !== index) })}
                onMove={(direction) => {
                  const next = [...value.rules];
                  const to = index + direction;
                  if (to < 0 || to >= next.length) return;
                  const [moved] = next.splice(index, 1);
                  next.splice(to, 0, moved!);
                  patch({ rules: next });
                }}
              />
            ))}
          </div>
        )}
        <AddButton
          disabled={disabled}
          label="Add rule"
          onClick={() =>
            patch({
              rules: [
                ...value.rules,
                {
                  clauses: [{ contextKind: "user", attribute: "", op: "in", values: [], negate: false }],
                  variation: flag.variations.length - 1,
                },
              ],
            })
          }
        />
      </Section>

      <Section
        step="4"
        title="Default"
        hint="Served to all traffic that does not match any targeting rules above."
      >
        <OutcomeEditor
          flag={flag}
          disabled={disabled}
          variation={value.fallthroughVariation}
          rollout={value.fallthroughRollout}
          onVariation={(variation) =>
            onChange({ ...value, fallthroughVariation: variation, fallthroughRollout: undefined })
          }
          onRollout={(rollout) =>
            onChange({ ...value, fallthroughRollout: rollout, fallthroughVariation: undefined })
          }
        />
      </Section>

      <Section
        step="off"
        title="Off variation"
        hint="Served whenever this flag is turned off or when a prerequisite fails."
      >
        <Select
          disabled={disabled}
          className="w-56"
          value={String(value.offVariation ?? 0)}
          onChange={(event) => patch({ offVariation: Number(event.target.value) })}
        >
          {flag.variations.map((variation) => (
            <option key={variation.idx} value={variation.idx}>
              {variationLabel(variation, flag.kind)}
            </option>
          ))}
        </Select>
      </Section>
    </div>
  );
}

/* ──────────────────────────────── rules ─────────────────────────────── */

function RuleCard({
  index,
  total,
  rule,
  flag,
  segments,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  rule: Rule;
  flag: FlagDefinition;
  segments: Segment[];
  disabled: boolean;
  onChange: (next: Rule) => void;
  onRemove: () => void;
  onMove: (direction: 1 | -1) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="accent">rule {index + 1}</Badge>
        <Input
          disabled={disabled}
          value={rule.description ?? ""}
          placeholder="What this rule is for"
          onChange={(event) => onChange({ ...rule, description: event.target.value })}
          className="h-7 flex-1 text-xs"
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled || index === 0}
          aria-label="Move up"
          onClick={() => onMove(-1)}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled || index === total - 1}
          aria-label="Move down"
          onClick={() => onMove(1)}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        <RemoveButton disabled={disabled} label="Remove rule" onClick={onRemove} />
      </div>

      <div className="space-y-2">
        {rule.clauses.map((clause, clauseIndex) => (
          <ClauseRow
            key={clauseIndex}
            clause={clause}
            first={clauseIndex === 0}
            segments={segments}
            disabled={disabled}
            onChange={(next) =>
              onChange({
                ...rule,
                clauses: rule.clauses.map((entry, at) => (at === clauseIndex ? next : entry)),
              })
            }
            onRemove={() =>
              onChange({ ...rule, clauses: rule.clauses.filter((_, at) => at !== clauseIndex) })
            }
          />
        ))}
        <AddButton
          disabled={disabled}
          label="Add condition"
          onClick={() =>
            onChange({
              ...rule,
              clauses: [
                ...rule.clauses,
                { contextKind: "user", attribute: "", op: "in", values: [], negate: false },
              ],
            })
          }
        />
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <OutcomeEditor
          flag={flag}
          disabled={disabled}
          variation={rule.variation}
          rollout={rule.rollout}
          onVariation={(variation) => onChange({ ...rule, variation, rollout: undefined })}
          onRollout={(rollout) => onChange({ ...rule, rollout, variation: undefined })}
        />
      </div>
    </div>
  );
}

function ClauseRow({
  clause,
  first,
  segments,
  disabled,
  onChange,
  onRemove,
}: {
  clause: Clause;
  first: boolean;
  segments: Segment[];
  disabled: boolean;
  onChange: (next: Clause) => void;
  onRemove: () => void;
}) {
  const inputKind = operatorInputKind(clause.op);
  const asText = clause.values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(", ");

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Clauses within a rule are AND. Saying so beats a legend nobody reads. */}
      <span className="w-10 shrink-0 text-right text-[11px] font-medium uppercase text-muted-foreground">
        {first ? "if" : "and"}
      </span>
      <Input
        disabled={disabled}
        className="h-7 w-20 text-xs"
        value={clause.contextKind}
        onChange={(event) => onChange({ ...clause, contextKind: event.target.value })}
        title="Context kind"
      />
      <Input
        disabled={disabled}
        className="h-7 w-36 text-xs"
        placeholder="attribute"
        value={clause.attribute}
        onChange={(event) => onChange({ ...clause, attribute: event.target.value })}
      />
      <Button
        variant={clause.negate ? "danger" : "ghost"}
        size="sm"
        disabled={disabled}
        onClick={() => onChange({ ...clause, negate: !clause.negate })}
        title="Negate this condition"
      >
        {clause.negate ? "not" : "is"}
      </Button>
      <Select
        disabled={disabled}
        className="h-7 w-36 text-xs"
        value={clause.op}
        onChange={(event) => onChange({ ...clause, op: event.target.value, values: [] })}
      >
        {OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </Select>

      {inputKind === "segment" ? (
        <Select
          disabled={disabled}
          className="h-7 w-48 text-xs"
          value={typeof clause.values[0] === "string" ? clause.values[0] : ""}
          onChange={(event) => onChange({ ...clause, values: [event.target.value] })}
        >
          <option value="">choose a segment…</option>
          {segments.map((segment) => (
            <option key={segment.key} value={segment.key}>
              {segment.name}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          disabled={disabled}
          type={inputKind === "date" ? "datetime-local" : "text"}
          className="h-7 flex-1 min-w-40 text-xs"
          placeholder={inputKind === "number" ? "42" : "comma separated values"}
          value={asText}
          onChange={(event) => {
            const raw = event.target.value;
            const parts = raw
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part.length > 0);
            const values =
              inputKind === "number"
                ? parts.map((part) => {
                    try {
                      return parseValue(part, "number");
                    } catch {
                      return part;
                    }
                  })
                : parts;
            onChange({ ...clause, values });
          }}
        />
      )}
      <RemoveButton disabled={disabled} label="Remove condition" onClick={onRemove} />
    </div>
  );
}

/* ─────────────────────── one variation, or a rollout ────────────────── */

function OutcomeEditor({
  flag,
  disabled,
  variation,
  rollout,
  onVariation,
  onRollout,
}: {
  flag: FlagDefinition;
  disabled: boolean;
  variation: number | undefined;
  rollout: Rule["rollout"] | undefined;
  onVariation: (variation: number) => void;
  onRollout: (rollout: Rule["rollout"]) => void;
}) {
  const isRollout = rollout !== undefined;
  const slices =
    rollout?.variations ??
    flag.variations.map((entry, index) => ({
      variationIndex: entry.idx,
      weight: index === 0 ? 100_000 : 0,
    }));
  const total = slices.reduce((sum, slice) => sum + slice.weight, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">Serve</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onVariation(variation ?? 0)}
            className={cn(
              "px-2.5 py-1 text-xs font-medium transition",
              !isRollout ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Single variation
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRollout({ contextKind: "user", variations: slices })}
            className={cn(
              "px-2.5 py-1 text-xs font-medium transition",
              isRollout ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Percentage rollout
          </button>
        </div>
      </div>

      {isRollout ? (
        <div className="space-y-2">
          {flag.variations.map((entry) => {
            const slice = slices.find((item) => item.variationIndex === entry.idx);
            const percent = toPercent(slice?.weight ?? 0);
            return (
              <div key={entry.idx} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-xs">
                  {variationLabel(entry, flag.kind)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.1}
                  disabled={disabled}
                  value={percent}
                  onChange={(event) => {
                    const next = flag.variations.map((candidate) => {
                      const existing = slices.find((item) => item.variationIndex === candidate.idx);
                      return {
                        variationIndex: candidate.idx,
                        weight:
                          candidate.idx === entry.idx
                            ? fromPercent(Number(event.target.value))
                            : (existing?.weight ?? 0),
                      };
                    });
                    onRollout({ ...(rollout ?? { contextKind: "user" }), variations: next });
                  }}
                  className="h-1 flex-1 accent-[var(--color-accent)]"
                />
                <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                  {percent.toFixed(1)}%
                </span>
              </div>
            );
          })}
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">
              Users are consistently bucketed by context key so each user reliably receives the same variation across sessions.
            </span>
            <span className={cn("font-mono", total === 100_000 ? "text-emerald-500" : "text-destructive")}>
              {toPercent(total).toFixed(1)}% total
            </span>
          </div>
        </div>
      ) : (
        <Select
          disabled={disabled}
          className="w-56"
          value={String(variation ?? 0)}
          onChange={(event) => onVariation(Number(event.target.value))}
        >
          {flag.variations.map((entry) => (
            <option key={entry.idx} value={entry.idx}>
              {variationLabel(entry, flag.kind)}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/* ─────────────────────────────── pieces ─────────────────────────────── */

function Section({
  step,
  title,
  hint,
  children,
}: {
  step: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground shadow-xs">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-secondary text-[10px] font-semibold text-secondary-foreground">
          {step}
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
      </header>
      <div className="space-y-2 p-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function AddButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button variant="ghost" size="sm" disabled={disabled} onClick={onClick}>
      <Plus className="size-3.5" />
      {label}
    </Button>
  );
}

function RemoveButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="hover:text-danger"
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

/** Shown when a segment clause names a segment that no longer exists. */
export function MissingSegmentWarning({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500 dark:text-amber-400">
      <Users className="mt-px size-3.5 shrink-0" />
      <span>
        The segment {keys.map((k) => `"${k}"`).join(", ")} {keys.length === 1 ? "is" : "are"} referenced in this rule but no longer exists. This rule condition will not match any users until updated.
      </span>
    </div>
  );
}
