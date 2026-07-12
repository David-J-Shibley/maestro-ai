import type { ChatMessage } from "../types.js";
import type { WorkflowFile, WorkflowStepPlan, WorkflowStateSnapshot } from "./types.js";

export type { WorkflowStateSnapshot };

export function buildStepMessages(
  step: WorkflowStepPlan,
  state: WorkflowStateSnapshot,
  originalMessages: ChatMessage[]
): ChatMessage[] {
  const system = buildSystemPrompt(step, state);
  const user = buildUserPrompt(step, state, originalMessages);
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildSystemPrompt(step: WorkflowStepPlan, state: WorkflowStateSnapshot): string {
  const lines = [
    "You are a step in a Maestro AI workflow.",
    `Step: ${step.name}`,
    `Purpose: ${step.purpose}`,
    `Expected output: ${step.expectedOutput}`,
    `Overall goal: ${state.goal}`,
    "Respond with only the output for this step — no meta commentary.",
  ];

  if (step.validation.requireSchema) {
    lines.push("Output must be valid JSON matching the requested schema.");
  }
  if (step.validation.requireNoPlaceholders) {
    lines.push("Do not use placeholders, TODOs, or incomplete sections.");
  }

  return lines.join("\n");
}

function buildUserPrompt(
  step: WorkflowStepPlan,
  state: WorkflowStateSnapshot,
  originalMessages: ChatMessage[]
): string {
  const parts: string[] = [`# Workflow goal\n${state.goal}`];

  if (state.files?.length) {
    parts.push("# Files");
    for (const f of state.files) {
      parts.push(`## ${f.path}\n${f.content}`);
    }
  }

  const deps = step.dependsOn.filter((id) => state.stepOutputs.has(id));
  if (deps.length) {
    parts.push("# Inputs from prior steps");
    for (const depId of deps) {
      const out = state.stepOutputs.get(depId);
      if (out?.content) {
        parts.push(`## ${depId}\n${out.content}`);
      }
    }
  }

  if (step.id === "execute" || step.id === "implement" || step.kind === "synthesis") {
    const originalUser = originalMessages.filter((m) => m.role === "user").pop()?.content;
    if (originalUser && !parts.some((p) => p.includes(originalUser))) {
      parts.push(`# Original request\n${originalUser}`);
    }
  }

  parts.push(`# Your task (${step.name})\n${step.purpose}`);

  return parts.join("\n\n");
}

export function getFinalOutput(
  plan: import("./types.js").WorkflowPlan,
  state: WorkflowStateSnapshot
): string {
  const terminalIds = ["revise", "synthesize", "review", "validate", "execute"];
  for (const id of terminalIds) {
    const out = state.stepOutputs.get(id);
    if (out?.content && out.status === "passed") return out.content;
  }

  const lastStep = plan.steps[plan.steps.length - 1];
  if (lastStep) {
    const out = state.stepOutputs.get(lastStep.id);
    if (out?.content) return out.content;
  }

  return "";
}
