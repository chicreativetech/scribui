import { WEB_ORIGINS } from "./lib.js";

// a click is needed: Chrome asks for a permission only from one
document.getElementById("allow").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: WEB_ORIGINS }).catch(() => false);
  if (ok) window.close();
  else document.getElementById("denied").hidden = false;
});
