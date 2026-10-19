// Runs on pages on this computer. ScribUI's canvas asks through it whether the
// extension can show other websites in its App view, and asks for that permission.
// Other pages never send these messages, so for them it does nothing.
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const type = e.data?.scribui;
  if (type !== "frames?" && type !== "frames-allow") return;
  chrome.runtime.sendMessage({ type }).then(
    (allowed) => window.postMessage({ scribui: "frames", allowed: !!allowed }, location.origin),
    () => {
      /* the extension was reloaded: this page keeps the old bridge */
    },
  );
});

// the permission was given (in the window the extension opened)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "frames") window.postMessage({ scribui: "frames", allowed: !!msg.allowed }, location.origin);
});
