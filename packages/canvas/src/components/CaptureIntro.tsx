import { Fragment, useEffect } from "react";

/**
 * The Capture Screens intro: a card over the tab the first time it opens (the
 * desktop app), or all the tab is in a browser, where capturing by hand isn't
 * available and the browser extension does it instead. In the desktop app the
 * app's own view covers the canvas, so the card is drawn by a view of its own
 * (desktop liveCard.ts) from these same words; in its test harness and in a
 * browser it's this component. Only **bold** and [links](https://…) are read.
 */

export type IntroCard = { title: string; paras: string[]; button: string };

const EXTENSION = "https://github.com/chicreativetech/scribui/tree/main/packages/extension#readme";
const RELEASES = "https://github.com/chicreativetech/scribui/releases";

export const DESKTOP_INTRO: IntroCard = {
  title: "Capture screens",
  paras: [
    "Your app runs here, as in a browser. Go to a screen you want to change and get it the way you want to comment on it: logged in, a menu open, a form filled in.",
    "Press **Capture view**, at the bottom right, to add it to Review exactly as it is. Name it in the bar above first, or pick **replace \"…\"** there to update a screen you captured before.",
    "Or mark it up right here with the tools beside it: the first mark captures the page.",
    "Then check your notes in **Review** and **Send** them to your coding agent.",
    "Pages from anywhere: the [ScribUI browser extension](" + EXTENSION + ") for Chrome (and Edge, Brave, Arc) sends the page in any tab to Review, logged-in pages included.",
  ],
  button: "Got it",
};

export const BROWSER_INTRO: IntroCard = {
  title: "Capture screens",
  paras: [
    "Capturing screens by hand works in the [ScribUI desktop app](" + RELEASES + "), where your app runs inside ScribUI. It isn't available in the browser.",
    "Here, use the [ScribUI browser extension](" + EXTENSION + ") for Chrome (and Edge, Brave, Arc): open your app in another tab, click the extension and press **Send to ScribUI**. The page arrives in Review with its elements, logged in or not.",
    "Or paste a screenshot or HTML into Review (**⌘V**), drop a file on it, or press **M**.",
  ],
  button: "Go to Review",
};

/** The desktop app keeps the seen hints across projects; a browser, per project. */
const DESKTOP_HINTS = typeof window !== "undefined" ? window.scribuiDesktop?.hints : undefined;
const KEY = "scribui:hint:";

export async function hintSeen(id: string): Promise<boolean> {
  if (DESKTOP_HINTS) return DESKTOP_HINTS.seen(id).catch(() => false);
  try {
    return localStorage.getItem(KEY + id) === "1";
  } catch {
    return false;
  }
}

export function markHintSeen(id: string) {
  if (DESKTOP_HINTS) return DESKTOP_HINTS.mark(id);
  try {
    localStorage.setItem(KEY + id, "1");
  } catch {
    /* shown again next time */
  }
}

/** **bold** and [label](https://…) as elements, the rest as text. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^)\s]+\))/).map((part, i) => {
        const b = /^\*\*(.+)\*\*$/.exec(part);
        const a = /^\[(.+)\]\((.+)\)$/.exec(part);
        if (b) return <b key={i}>{b[1]}</b>;
        if (a)
          return (
            <a key={i} href={a[2]} target="_blank" rel="noreferrer">
              {a[1]}
            </a>
          );
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

/** The card over what's behind it, which it dims; its button (or Escape) closes it. */
export function IntroCardView({ card, onClose }: { card: IntroCard; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="intro-scrim">
      <div className="intro-card" role="dialog" aria-modal="true" aria-label={card.title}>
        <h1>
          {card.title}
          <span className="accent">.</span>
        </h1>
        {card.paras.map((p, i) => (
          <p key={i}>
            <Rich text={p} />
          </p>
        ))}
        <button className="intro-button" onClick={onClose} autoFocus>
          {card.button}
        </button>
      </div>
    </div>
  );
}
