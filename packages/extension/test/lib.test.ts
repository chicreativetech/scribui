import { describe, expect, it } from "vitest";
import { capturable, defaultRole, findProjects, renderWidth, type Project } from "../lib.js";

const project = (p: Partial<Project>): Project => ({ port: 4382, url: "http://127.0.0.1:4382/", root: "/x", name: "X", canRenderPages: true, ...p });

describe("finding ScribUI", () => {
  it("asks every port in the range and any added one, keeps ScribUI projects, one per project", async () => {
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      const port = Number(new URL(url).port);
      const json = (b: unknown) => ({ ok: true, json: async () => b }) as Response;
      if (port === 4382) return json({ folder: ".scribui", root: "/work/shop", manifest: { version: 1, app: { name: "Shop", platform: "web", baseUrl: "http://localhost:3000" } }, canRenderPages: true });
      // the same project's second server (desktop and CLI): shown once
      if (port === 4384) return json({ folder: ".scribui", root: "/work/shop", manifest: { error: "x" } });
      if (port === 4385) return json({ hello: "something else" });
      if (port === 5000) return json({ folder: ".scribui", root: "/work/bank-app", manifest: { error: "screens.json can't be read" }, canRenderPages: false });
      throw new Error("connection refused");
    }) as typeof fetch;
    const found = await findProjects([5000], get);
    expect(asked).toHaveLength(11);
    expect(found).toEqual([
      { port: 4382, url: "http://127.0.0.1:4382/", root: "/work/shop", name: "Shop", platform: "web", baseUrl: "http://localhost:3000", canRenderPages: true },
      { port: 5000, url: "http://127.0.0.1:5000/", root: "/work/bank-app", name: "bank-app", platform: undefined, baseUrl: undefined, canRenderPages: false },
    ]);
  });
});

describe("what the page is", () => {
  it("the app's own pages are screens of it; anything else is a reference", () => {
    const web = project({ platform: "web", baseUrl: "https://staging.shop.example" });
    expect(defaultRole("https://staging.shop.example/cart", web)).toBe("app");
    expect(defaultRole("http://localhost:5173/", web)).toBe("app");
    expect(defaultRole("https://stripe.com/checkout", web)).toBe("reference");
    // a phone app's project: a local web page isn't the app
    expect(defaultRole("http://localhost:5173/", project({ platform: "ios" }))).toBe("reference");
    expect(defaultRole("not a url", web)).toBe("reference");
  });

  it("only web pages can be captured; widths stay within what ScribUI renders", () => {
    expect(capturable("https://example.com/")).toBe(true);
    expect(capturable("chrome://settings")).toBe(false);
    expect(capturable("https://chromewebstore.google.com/detail/x")).toBe(false);
    expect(capturable(undefined)).toBe(false);
    expect(renderWidth(3840)).toBe(2560);
    expect(renderWidth(280)).toBe(320);
    expect(renderWidth(1512.4)).toBe(1512);
  });
});
