import type { Platform, ScreenManifest } from "./schemas.js";

const START = "<!-- scribui:start -->";
const END = "<!-- scribui:end -->";
/** The section written under ScribUI's earlier name, replaced in place. */
const LEGACY_START = "<!-- intentcue:start -->";
const LEGACY_END = "<!-- intentcue:end -->";

export const AGENT_SECTION = `${START}
## Visual design review

Design feedback lives in \`.scribui/\`.

- Before any UI work, read \`.scribui/rules.md\` and follow it.
- When \`.scribui/latest/status.json\` says \`sent\`, implement \`.scribui/latest/review.md\`,
  then set its status to \`applied\` and add \`"changedScreens"\`: the ids of every screen whose UI
  you changed (check screens that share the components you edited), or \`"all"\` if you changed
  shared styles, theme or design-system components. Only those screens are recaptured.
- When you add, remove or change screens, update \`.scribui/screens.json\`.
- If an instruction is marked \`unresolved\`, ask the user instead of guessing.
- To request a review, run \`npx scribui capture\` and tell the user it is ready.
${END}
`;

/**
 * Android and iOS: the user captures every screen by hand in the desktop
 * app's Device tab, so the agent neither lists screens nor starts captures.
 */
export const MOBILE_AGENT_SECTION = `${START}
## Visual design review

Design feedback lives in \`.scribui/\`. The user captures the app's screens by hand in the ScribUI
desktop app (its Device tab) and marks them up there.

- Before any UI work, read \`.scribui/rules.md\` and follow it.
- When \`.scribui/latest/status.json\` says \`sent\`, implement \`.scribui/latest/review.md\`,
  then set its status to \`applied\` and add \`"changedScreens"\`: the ids of every screen whose UI
  you changed (check screens that share the components you edited), or \`"all"\` if you changed
  shared styles, theme or design-system components. The user rebuilds the app and captures those
  screens again.
- If an instruction is marked \`unresolved\`, ask the user instead of guessing.
- To request a review, tell the user the app is ready to review in ScribUI.
${END}
`;

/** The section for a project's platform. */
export const agentSection = (platform: Platform = "web") => (platform === "web" ? AGENT_SECTION : MOBILE_AGENT_SECTION);

/** Insert or refresh the ScribUI section in an AGENTS.md / CLAUDE.md body. */
export function upsertAgentSection(existing: string | null, platform: Platform = "web"): string {
  const AGENT_SECTION = agentSection(platform);
  if (!existing || !existing.trim()) return `# Agent instructions\n\n${AGENT_SECTION}`;
  for (const [start, end] of [
    [START, END],
    [LEGACY_START, LEGACY_END],
  ] as const) {
    const s = existing.indexOf(start);
    const e = existing.indexOf(end);
    if (s !== -1 && e !== -1 && e > s) return existing.slice(0, s) + AGENT_SECTION.trimEnd() + existing.slice(e + end.length);
  }
  return existing.replace(/\s*$/, "\n\n") + AGENT_SECTION;
}

export function exampleManifest(platform: "ios" | "android" | "web", name: string): ScreenManifest {
  if (platform === "web") {
    return {
      version: 1,
      app: { name, platform, baseUrl: "http://localhost:3000" },
      screens: [
        { id: "home", title: "Home", group: "Main", url: "/", viewport: { width: 390, height: 844, deviceScaleFactor: 2 } },
        { id: "settings", title: "Settings", group: "Main", url: "/settings", viewport: { width: 390, height: 844, deviceScaleFactor: 2 } },
      ],
    };
  }
  return {
    version: 1,
    app: { name, platform, bundleId: "com.example.app" },
    screens: [
      { id: "home", title: "Home", group: "Main", flow: "flows/home.yaml" },
      { id: "settings", title: "Settings", group: "Main", flow: "flows/settings.yaml" },
    ],
  };
}

export const RULES_HEADER = `# Design rules

Persistent design rules for this project. The coding agent reads this file before any UI work.
ScribUI appends new rules at the end; edit freely, your edits are kept.

`;
