// ─── Domain types ────────────────────────────────────────────────────────────

export interface Application {
  id: string;
  name: string;
  label: string;
  description: string;
}

export interface ActionSummary {
  id: string;
  name: string;
  label: string;
  description: string;
}

export interface TriggerSummary {
  id: string;
  name: string;
  label: string;
  description: string;
}

/** A single field extracted from a JSON-Schema-style describe/input or describe/output response. */
export interface SchemaField {
  /** Dot-separated path from the root, e.g. "cards[].id" or "data.card.board.id" */
  path: string;
  /** The leaf key name */
  name: string;
  /** JSON Schema type string */
  type: string;
  /** Human-readable title (from "title" or "displayTitle" in the schema) */
  title: string;
  /** Human-readable description */
  description: string;
  /** Whether the field is required (only meaningful for input fields) */
  required: boolean;
  /** True when this field sits inside an array */
  isArrayItem: boolean;
  /** The immediate parent key (empty string for top-level fields) */
  parentKey: string;
}

// ─── Metadata cache ──────────────────────────────────────────────────────────

export interface ActionMetadata {
  summary: ActionSummary;
  inputFields: SchemaField[];
  outputFields: SchemaField[];
}

export interface TriggerMetadata {
  summary: TriggerSummary;
  inputFields: SchemaField[];
  outputFields: SchemaField[];
}

export interface ApplicationMetadata {
  application: Application;
  actions: ActionMetadata[];
  triggers: TriggerMetadata[];
}

// ─── Input classification ────────────────────────────────────────────────────

export type InputStatus =
  | "DIRECT"             // The value was provided explicitly in the user request
  | "DERIVED"            // The value can be computed without an extra action call
  | "RESOLVABLE_BY_ACTION" // Another action can produce this value
  | "AMBIGUOUS"          // Multiple candidates exist and disambiguation is needed
  | "MISSING";           // No available action can resolve this value

export interface ClassifiedInput {
  fieldPath: string;
  fieldTitle: string;
  status: InputStatus;
  /** The value string when status === DIRECT or DERIVED */
  directValue?: string;
  /** Name of the supporting action when status === RESOLVABLE_BY_ACTION */
  resolvedByAction?: string;
  /** The output field path on the supporting action that provides this value */
  resolvedByOutputPath?: string;
}

// ─── Dependency graph ────────────────────────────────────────────────────────

export interface OutputToInputMapping {
  /** Supporting action name */
  fromAction: string;
  /** Output field path on the supporting action */
  fromPath: string;
  /** Primary (or downstream) action name */
  toAction: string;
  /** Input field path on the primary action */
  toPath: string;
}

export interface DependencyNode {
  actionName: string;
  actionId: string;
  kind: "primary" | "supporting";
  /** Input values that come directly from the user (DIRECT) */
  directInputs: Record<string, string>;
  /** Output→Input mappings that feed FROM this node to downstream nodes */
  provides: OutputToInputMapping[];
  /** Output→Input mappings that feed INTO this node from upstream nodes */
  requires: OutputToInputMapping[];
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  /** Topologically sorted list of action names (leaves first → primary last) */
  executionOrder: string[];
}

// ─── Execution plan ──────────────────────────────────────────────────────────

export interface ExecutionStep {
  step: number;
  /** "trigger" | "action" */
  kind: "trigger" | "action";
  action: string;
  actionId: string;
  purpose?: string;
  inputs: Record<string, string>;
  /** Maps output field path → "TargetAction.inputFieldPath" */
  outputs?: Record<string, string>;
}

export interface AnalysisResult {
  status: "resolvable" | "ambiguous" | "unresolvable" | "error";
  application: {
    name: string;
    appId: string;
  };
  request: string;
  /** The trigger that starts this workflow, if the request is trigger-driven */
  triggerAction?: {
    name: string;
    triggerId: string;
  };
  primaryAction: {
    name: string;
    actionId: string;
  } | null;
  classifiedInputs: ClassifiedInput[];
  executionPlan: ExecutionStep[];
  issues: string[];
  humanReadable: string;
}
