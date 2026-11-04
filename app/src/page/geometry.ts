// Quads (8 numbers, clockwise from top-left) and points, in CSS pixels of a viewport.
export type Quad = number[];
export interface Point { x: number; y: number }

export function quadCenter(q: Quad): Point {
  return {x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4};
}

/** Area by the shoelace formula. */
export function quadArea(q: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  return Math.abs(area / 2);
}

/** The centre of the part of the quad's bounding box that is inside the viewport, or null when none is. */
export function visibleCenter(q: Quad, viewport: {width: number; height: number}): Point | null {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const left = Math.max(0, Math.min(...xs)), right = Math.min(viewport.width, Math.max(...xs));
  const top = Math.max(0, Math.min(...ys)), bottom = Math.min(viewport.height, Math.max(...ys));
  if (right <= left || bottom <= top) return null;
  return {x: (left + right) / 2, y: (top + bottom) / 2};
}

/**
 * A point of a child frame's viewport placed in its parent's viewport: as fractions of the child viewport, onto the
 * owner iframe's content quad (top-left, top-right, bottom-right, bottom-left), so a scaled iframe is right too.
 */
export function toParent(p: Point, ownerContent: Quad, childViewport: {width: number; height: number}): Point {
  const fx = p.x / Math.max(1, childViewport.width), fy = p.y / Math.max(1, childViewport.height);
  const c = ownerContent;
  return {x: c[0] + (c[2] - c[0]) * fx + (c[6] - c[0]) * fy, y: c[1] + (c[3] - c[1]) * fx + (c[7] - c[1]) * fy};
}
