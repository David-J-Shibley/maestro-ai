import type { ModelTier, TaskAnalysis } from "../types.js";
import { isLocalTier } from "../types.js";

/** Whether a tier can reasonably serve the analyzed task. */
export function tierMeetsTask(analysis: TaskAnalysis, tier: ModelTier): boolean {
  if (tier === "premium") return true;
  if (tier === "hosted_oss") {
    return !(
      analysis.difficulty === "hard" ||
      analysis.riskLevel === "high" ||
      analysis.taskType === "architecture"
    );
  }
  if (tier === "local_strong") {
    return !(
      analysis.difficulty === "hard" ||
      analysis.riskLevel === "high" ||
      analysis.taskType === "architecture" ||
      (analysis.requiresToolUse &&
        analysis.requiresCodeReasoning &&
        analysis.difficulty === "medium")
    );
  }
  if (tier === "local_fast") {
    return (
      analysis.difficulty === "easy" &&
      analysis.riskLevel !== "high" &&
      analysis.taskType !== "architecture" &&
      !analysis.requiresLongContext &&
      !(analysis.requiresToolUse && analysis.requiresCodeReasoning)
    );
  }
  return isLocalTier(tier);
}
