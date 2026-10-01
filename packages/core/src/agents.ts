import type { ScreenManifest } from "./schemas.js";

const START = "<!-- intentcue:start -->";
const END = "<!-- intentcue:end -->";

export const AGENT_SECTION = `${START}
## Visual design review

Design feedback lives in \`.intentcue/\`.

- Before any UI work, read \`.intentcue/rules.md\` and follow it.
- When \`.intentcue/latest/status.json\` says \`sent\`, implement \`.intentcue/latest/review.md\`,
  then set its status to \`applied\` and add \`"changedScreens"\`: the ids of every screen whose UI
  you changed (check screens that share the components you edited), or \`"all"\` if you changed
  shared styles, theme or design-system components. Only those screens are recaptured.
- When you add, remove or change screens, update \`.intentcue/screens.json\`.
- If an instruction is marked \`unresolved\`, ask the user instead of guessing.
- To request a review, run \`npx intentcue capture\` and tell the user it is ready.
${END}
`;

/** Insert or refresh the intentcue section in an AGENTS.md / CLAUDE.md body. */
export function upsertAgentSection(existing: string | null): string {
  if (!existing || !existing.trim()) return `# Agent instructions\n\n${AGENT_SECTION}`;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    return existing.slice(0, s) + AGENT_SECTION.trimEnd() + existing.slice(e + END.length);
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
intentcue appends new rules at the end; edit freely, your edits are kept.

`;
