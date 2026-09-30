const KNOWN_TOOLS: Record<string, string> = {
  run_shell: "Runs a raw shell command with your full user account's access to this computer — it can read, write, or delete files and reach the network.",
  run_node: "Runs raw Node.js code with your full user account's access to this computer — it can read, write, or delete files and reach the network.",
  run_python: "Runs raw Python code with your full user account's access to this computer — it can read, write, or delete files and reach the network.",
  generate_image: "Generates an image using your local image-generation server.",
  generate_video: "Generates a short video using your local video-generation setup (LTX-Video). Can take several minutes.",
  see_image: "Looks at an image with a local vision model and describes it or answers a question about it.",
  remember: "Saves a short note to AURORA's persistent memory.",
  recall: "Reads back notes from AURORA's persistent memory.",
  list_skills: "Lists the skills currently installed.",
  save_deliverable: "Saves a finished piece of work to this agent's outbox for you to review.",
  handoff_to_agent: "Hands this piece of work off to another one of your agents.",
  message_agent: "Sends a message to another one of your agents without reassigning the work.",
};

export function toolNameFromAction(action: string): string {
  const idx = action.indexOf("(");
  return idx === -1 ? action : action.slice(0, idx);
}

export function describeToolCall(action: string, risk: string): string {
  const toolName = toolNameFromAction(action);
  if (KNOWN_TOOLS[toolName]) return KNOWN_TOOLS[toolName];
  if (risk === "high") {
    return `Runs the "${toolName}" tool from an installed skill. High-risk skill tools can run code or touch files on this computer — review carefully.`;
  }
  if (risk === "medium") return `Runs the "${toolName}" tool from an installed skill.`;
  return `Runs the "${toolName}" tool.`;
}

export function describeApproval(targetType: string, action: string, risk: string): string {
  if (targetType === "skill_install") {
    const fromBundle = action.includes("bundled starter skill");
    const source = fromBundle ? "Installs a skill bundled with AURORA" : "Downloads and installs a skill from GitHub";
    return `${source}. None of its code has run yet — review what it declares below. Approving enables its tools for future use; denying deletes the staged copy.`;
  }
  return describeToolCall(action, risk);
}
