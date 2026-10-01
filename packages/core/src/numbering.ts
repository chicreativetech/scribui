import type { Annotation } from "./schemas.js";

/**
 * Marker numbers shared by the canvas badges, the annotated screenshots and
 * the instruction ids: screens in manifest order, annotations in drawing
 * order. Attached comments share their parent's number; rules are numbered
 * separately (U1, U2, …).
 */
export function numberAnnotations(
  annotations: readonly Annotation[],
  screenOrder: readonly string[],
): { markers: Map<string, number>; rules: Map<string, number> } {
  const order = new Map(screenOrder.map((id, i) => [id, i]));
  const rank = (a: Annotation) => order.get(a.screenId) ?? screenOrder.length;
  const indexed = annotations.map((a, i) => ({ a, i }));
  indexed.sort((x, y) => {
    const d = rank(x.a) - rank(y.a);
    if (d !== 0) return d;
    if (rank(x.a) === screenOrder.length && x.a.screenId !== y.a.screenId)
      return x.a.screenId < y.a.screenId ? -1 : 1;
    return x.i - y.i;
  });

  const ids = new Set(annotations.map((a) => a.id));
  const markers = new Map<string, number>();
  const rules = new Map<string, number>();
  let n = 0;
  let u = 0;
  for (const { a } of indexed) {
    if (a.kind === "rule") rules.set(a.id, ++u);
    else if (a.kind === "comment" && a.attachedTo && ids.has(a.attachedTo)) continue;
    else markers.set(a.id, ++n);
  }
  for (const a of annotations) {
    if (a.kind === "comment" && a.attachedTo && markers.has(a.attachedTo))
      markers.set(a.id, markers.get(a.attachedTo)!);
  }
  return { markers, rules };
}
