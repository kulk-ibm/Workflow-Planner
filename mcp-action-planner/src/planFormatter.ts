/**
 * planFormatter.ts
 *
 * Converts the internal dependency graph and classified inputs into:
 *  - A structured AnalysisResult (JSON-serialisable)
 *  - A human-readable text plan
 *
 * Supports both action-only and trigger-driven workflows.
 */

import {
  ActionMetadata,
  AnalysisResult,
  Application,
  ClassifiedInput,
  DependencyGraph,
  ExecutionStep,
  TriggerMetadata,
} from "./types.js";

// ─── Parameters passed in from requestAnalyzer ───────────────────────────────

export interface FormatterInput {
  request: string;
  app: Application;
  /** Present when the request is trigger-driven */
  triggerMeta?: TriggerMetadata;
  primaryActionMeta: ActionMetadata;
  classifiedInputs: ClassifiedInput[];
  graph: DependencyGraph;
  issues: string[];
  status: AnalysisResult["status"];
  allSupportingCandidates: ActionMetadata[];
  entityValues: Map<string, string>;
}

// ─── Build execution plan steps ──────────────────────────────────────────────

function buildExecutionPlan(
  graph: DependencyGraph,
  triggerMeta: TriggerMetadata | undefined
): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let stepCounter = 1;

  // Step 0 (shown as step 1): Trigger entry point for trigger-driven workflows
  if (triggerMeta) {
    // Find what outputs from the trigger feed into downstream actions
    const triggerOutputMappings: Record<string, string> = {};
    for (const node of graph.nodes) {
      for (const req of node.requires) {
        if (req.fromAction === triggerMeta.summary.label) {
          triggerOutputMappings[req.fromPath] = `${req.toAction}.${req.toPath}`;
        }
      }
    }

    steps.push({
      step: stepCounter++,
      kind: "trigger",
      action: triggerMeta.summary.label,
      actionId: triggerMeta.summary.id,
      purpose: "Workflow entry point — fires when the event occurs",
      inputs: {},
      ...(Object.keys(triggerOutputMappings).length > 0
        ? { outputs: triggerOutputMappings }
        : {}),
    });
  }

  // Remaining steps: supporting actions + primary action
  for (const actionName of graph.executionOrder) {
    const node = graph.nodes.find((n) => n.actionName === actionName);
    if (!node) continue;

    // Skip the trigger node — it's already handled above
    if (triggerMeta && actionName === triggerMeta.summary.label) continue;

    const isPrimary = node.kind === "primary";

    // Build inputs map
    const inputs: Record<string, string> = { ...node.directInputs };

    if (isPrimary) {
      for (const req of node.requires) {
        inputs[req.toPath] = `${req.fromAction}.${req.fromPath}`;
      }
    }

    // Build outputs map (only for non-primary nodes)
    let outputs: Record<string, string> | undefined;
    if (!isPrimary && node.provides.length > 0) {
      outputs = {};
      for (const prov of node.provides) {
        outputs[prov.fromPath] = `${prov.toAction}.${prov.toPath}`;
      }
    }

    // Purpose for supporting actions
    let purpose: string | undefined;
    if (!isPrimary && node.provides.length > 0) {
      const resolvedFields = node.provides.map((p) => p.toPath).join(", ");
      purpose = `Resolve ${resolvedFields}`;
    }

    steps.push({
      step: stepCounter++,
      kind: "action",
      action: actionName,
      actionId: node.actionId,
      ...(purpose ? { purpose } : {}),
      inputs,
      ...(outputs ? { outputs } : {}),
    });
  }

  return steps;
}

// ─── Human-readable formatter ─────────────────────────────────────────────────

function buildHumanReadable(
  request: string,
  executionPlan: ExecutionStep[],
  issues: string[]
): string {
  const lines: string[] = [];

  lines.push(`Request:\n${request}`);
  lines.push("");

  if (issues.length > 0) {
    lines.push("Issues:");
    for (const issue of issues) lines.push(`  ⚠ ${issue}`);
    lines.push("");
  }

  if (executionPlan.length === 0) {
    lines.push("No execution plan could be constructed.");
    return lines.join("\n");
  }

  lines.push("Plan:");
  lines.push("");

  for (const step of executionPlan) {
    const kindLabel = step.kind === "trigger" ? " [TRIGGER]" : "";
    lines.push(`${step.step}.${kindLabel} ${step.action}`);

    if (step.purpose) {
      lines.push(`   └─ ${step.purpose}`);
    }

    // Direct inputs (user-supplied values)
    const directEntries = Object.entries(step.inputs).filter(([, v]) => !v.includes("."));
    if (directEntries.length > 0) {
      lines.push("");
      lines.push("   Inputs from request:");
      for (const [k, v] of directEntries) {
        lines.push(`   ├─ ${k} = "${v}"`);
      }
    }

    // Inputs resolved from other actions/triggers
    const resolvedEntries = Object.entries(step.inputs).filter(([, v]) => v.includes("."));
    if (resolvedEntries.length > 0) {
      lines.push("");
      lines.push("   Inputs:");
      const last = resolvedEntries.length - 1;
      resolvedEntries.forEach(([k, v], idx) => {
        const branch = idx === last ? "└─" : "├─";
        lines.push(`   ${branch} ${k} ← ${v}`);
      });
    }

    // Outputs this step provides to downstream steps
    if (step.outputs && Object.keys(step.outputs).length > 0) {
      lines.push("");
      lines.push("   Provides:");
      const outEntries = Object.entries(step.outputs);
      const last = outEntries.length - 1;
      outEntries.forEach(([k, v], idx) => {
        const branch = idx === last ? "└─" : "├─";
        lines.push(`   ${branch} ${k} → ${v}`);
      });
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildAnalysisResult(input: FormatterInput): AnalysisResult {
  const executionPlan = buildExecutionPlan(input.graph, input.triggerMeta);

  const humanReadable = buildHumanReadable(input.request, executionPlan, input.issues);

  return {
    status: input.status,
    application: {
      name: input.app.name,
      appId: input.app.id,
    },
    request: input.request,
    ...(input.triggerMeta
      ? {
          triggerAction: {
            name: input.triggerMeta.summary.label,
            triggerId: input.triggerMeta.summary.id,
          },
        }
      : {}),
    primaryAction: {
      name: input.primaryActionMeta.summary.label,
      actionId: input.primaryActionMeta.summary.id,
    },
    classifiedInputs: input.classifiedInputs,
    executionPlan,
    issues: input.issues,
    humanReadable,
  };
}
