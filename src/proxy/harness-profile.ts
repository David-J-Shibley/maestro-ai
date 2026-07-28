export type HarnessProfileName = "claude-code" | "cursor" | "openai";

export interface HarnessProfile {
  name: HarnessProfileName;
  /** Omit tools + plain-reply when analysis says tools omittable. */
  omitToolsWhenOmittable: boolean;
  /** Use Anthropic ask extraction / meta detection. */
  anthropicAskExtraction: boolean;
  /** Bias session sticky toward local for chitchat. */
  stickyLocalBias: boolean;
  /** Extra plain-text system hint (appended). */
  plainTextHintExtra?: string;
}

const PROFILES: Record<HarnessProfileName, HarnessProfile> = {
  "claude-code": {
    name: "claude-code",
    omitToolsWhenOmittable: true,
    anthropicAskExtraction: true,
    stickyLocalBias: true,
    plainTextHintExtra:
      "Never emit JSON with a \"name\" and \"parameters\" field. Never call Memory or Write.",
  },
  cursor: {
    name: "cursor",
    omitToolsWhenOmittable: false,
    anthropicAskExtraction: false,
    stickyLocalBias: false,
  },
  openai: {
    name: "openai",
    omitToolsWhenOmittable: false,
    anthropicAskExtraction: false,
    stickyLocalBias: false,
  },
};

export function isHarnessProfileName(value: string): value is HarnessProfileName {
  return value === "claude-code" || value === "cursor" || value === "openai";
}

export function resolveHarnessProfile(
  name?: string | null
): HarnessProfile {
  if (name && isHarnessProfileName(name)) return PROFILES[name];
  return PROFILES["claude-code"];
}
