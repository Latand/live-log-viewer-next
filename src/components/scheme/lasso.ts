import type { Camera } from "./Minimap";
import type { SchemeNode, SchemeRect } from "./layout";

export function dragRect(x1: number, y1: number, x2: number, y2: number): SchemeRect {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function screenRectToWorld(rect: SchemeRect, cam: Camera): SchemeRect {
  return {
    x: (rect.x - cam.x) / cam.z,
    y: (rect.y - cam.y) / cam.z,
    w: rect.w / cam.z,
    h: rect.h / cam.z,
  };
}

export function rectsIntersect(a: SchemeRect, b: SchemeRect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function nodesInRect(nodes: readonly SchemeNode[], world: SchemeRect): string[] {
  return nodes.filter((node) => rectsIntersect(node, world)).map((node) => node.file.path);
}

export function selectionBBox(nodes: readonly SchemeNode[], paths: ReadonlySet<string>): SchemeRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const node of nodes) {
    if (!paths.has(node.file.path)) continue;
    found = true;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }

  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pruneSelection(paths: ReadonlySet<string>, nodes: readonly SchemeNode[]): ReadonlySet<string> {
  const present = new Set(nodes.map((node) => node.file.path));
  for (const path of paths) {
    if (!present.has(path)) {
      return new Set([...paths].filter((selected) => present.has(selected)));
    }
  }
  return paths;
}
