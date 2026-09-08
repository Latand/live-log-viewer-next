import type { WorkNode } from './fixtures';
export type Camera = { x: number; y: number; z: number };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const W = 620, H = 650;

// Screen dimensions vary continuously; a node's world anchor never changes.
// The active reader stays at a useful reading scale while its local edges enter view.
export function nodeFrame(n: WorkNode, camera: Camera, height: number, reader: string | null, dense: boolean) {
  const floor = Math.min(.92, (height - 160) / H);
  const reading = n.id === reader && n.kind === 'conversation';
  const native = n.kind === 'conversation' && (camera.z >= .82 || (reading && camera.z > .52));
  const nativeScale = reading ? floor : Math.min(camera.z, floor);
  if (native) return { w: W * nativeScale, h: H * nativeScale, native, nativeScale, rich: false };
  const baseW = dense ? 144 : clamp(camera.z * 1000, 144, 184);
  const baseH = n.kind === 'task' ? 100 : dense ? 84 : 96;
  if (dense && n.kind === 'task' && camera.z < .6) return { w: 220, h: 48, native: false, nativeScale: 1, rich: false };
  if (n.kind === 'task' && camera.z >= .6) return { w: Math.min(400, 430 * camera.z), h: 240, native: false, nativeScale: 1, rich: true };
  const t = reading ? clamp((camera.z - .32) / .2, 0, 1) : 0;
  return { w: baseW + (W * floor - baseW) * t, h: baseH + (H * floor - baseH) * t, native: false, nativeScale: 1, rich: t > .1 };
}

export function essentialRole(n: WorkNode) {
  return n.role.replace(/ · (passed|complete|returned|next)$/, '');
}
export function essentialState(n: WorkNode) {
  if (n.status === 'waiting') return '1 finding returned';
  if (n.status === 'queued') return 'Waiting';
  if (n.status === 'done') return /passed/.test(n.role) ? 'Passed' : 'Complete';
  return 'Working';
}
