/**
 * WebGL instanced renderer for timeline strips.
 * Each strip is a quad instance: (t_start, t_end, y_offset, height, r, g, b).
 * Viewport changes only update a uniform matrix — zero GPU data transfer.
 */

const VERT = `
attribute vec2 a_pos;
attribute float a_ts;
attribute float a_te;
attribute float a_yo;
attribute float a_h;
attribute vec3 a_color;

uniform vec2 u_xTf; // scale, offset: clip_x = time * scale + offset
uniform vec2 u_yTf; // scale, offset: clip_y = bytes * scale + offset

varying vec3 v_color;

void main() {
  float t = mix(a_ts, a_te, a_pos.x);
  float b = a_yo + a_pos.y * a_h;
  gl_Position = vec4(t * u_xTf.x + u_xTf.y, b * u_yTf.x + u_yTf.y, 0.0, 1.0);
  v_color = a_color;
}
`;

const FRAG = `
precision mediump float;
varying vec3 v_color;
void main() { gl_FragColor = vec4(v_color, 1.0); }
`;

function createShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

export interface GLState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  instanceVBO: WebGLBuffer;
  instanceCount: number;
  uXTf: WebGLUniformLocation;
  uYTf: WebGLUniformLocation;
}

export function initGL(canvas: HTMLCanvasElement): GLState | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: false });
  if (!gl) return null;

  const ext = gl.getExtension("ANGLE_instanced_arrays");
  if (!ext) return null;

  const vs = createShader(gl, gl.VERTEX_SHADER, VERT);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  // Unit quad
  const quadVBO = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 1,1, 0,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Index buffer
  const ibo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);

  // Instance buffer (will be filled later)
  const instanceVBO = gl.createBuffer()!;

  // Instance attributes
  const stride = 7 * 4; // 7 floats per instance
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
  const attrs = ["a_ts", "a_te", "a_yo", "a_h"];
  for (let i = 0; i < attrs.length; i++) {
    const loc = gl.getAttribLocation(program, attrs[i]);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, stride, i * 4);
    ext.vertexAttribDivisorANGLE(loc, 1);
  }
  const aColor = gl.getAttribLocation(program, "a_color");
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, stride, 4 * 4);
  ext.vertexAttribDivisorANGLE(aColor, 1);

  // Store ext on gl for draw calls
  (gl as any)._ext = ext;

  return {
    gl,
    program,
    instanceVBO,
    instanceCount: 0,
    uXTf: gl.getUniformLocation(program, "u_xTf")!,
    uYTf: gl.getUniformLocation(program, "u_yTf")!,
  };
}

const PALETTE_RGB: [number, number, number][] = [
  [0.231,0.510,0.965], [0.937,0.267,0.267], [0.133,0.773,0.369], [0.961,0.620,0.043], [0.545,0.361,0.965],
  [0.024,0.714,0.831], [0.925,0.302,0.600], [0.078,0.722,0.651], [0.976,0.451,0.086], [0.388,0.400,0.945],
  [0.518,0.800,0.086], [0.910,0.475,0.976], [0.055,0.647,0.890], [0.984,0.573,0.235], [0.655,0.545,0.980],
];

export function uploadStrips(
  state: GLState,
  blocks: { strips: { t_start: number; t_end: number; y_offset: number }[]; size: number; idx: number }[],
) {
  const { gl, instanceVBO } = state;

  // Count total strips
  let total = 0;
  for (const b of blocks) total += b.strips.length;

  const buf = new Float32Array(total * 7);
  let off = 0;
  for (const block of blocks) {
    const [r, g, b] = PALETTE_RGB[block.idx % PALETTE_RGB.length];
    for (const strip of block.strips) {
      buf[off++] = strip.t_start;
      buf[off++] = strip.t_end;
      buf[off++] = strip.y_offset;
      buf[off++] = block.size;
      buf[off++] = r;
      buf[off++] = g;
      buf[off++] = b;
    }
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
  gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
  state.instanceCount = total;
}

export function drawStrips(
  state: GLState,
  canvasW: number,
  canvasH: number,
  plotLeft: number,
  plotTop: number,
  plotW: number,
  plotH: number,
  tMin: number,
  tMax: number,
  maxBytes: number,
) {
  const { gl, program, uXTf, uYTf, instanceCount } = state;
  if (instanceCount === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvasW * dpr, h = canvasH * dpr;
  if (gl.canvas.width !== w || gl.canvas.height !== h) {
    gl.canvas.width = w;
    gl.canvas.height = h;
    (gl.canvas as HTMLCanvasElement).style.width = `${canvasW}px`;
    (gl.canvas as HTMLCanvasElement).style.height = `${canvasH}px`;
  }

  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Scissor to plot area
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(plotLeft * dpr, (canvasH - plotTop - plotH) * dpr, plotW * dpr, plotH * dpr);

  gl.useProgram(program);

  // Compute affine transform: world → clip space
  // clip_x = (time - tMin) / (tMax - tMin) * (2 * plotW / canvasW) + (2 * plotLeft / canvasW - 1)
  const xScale = (2 * plotW) / (canvasW * (tMax - tMin));
  const xOffset = (2 * plotLeft) / canvasW - 1 - tMin * xScale;

  // clip_y: bytes=0 at bottom of plot, bytes=maxBytes at top
  // pixel_y = plotTop + plotH - bytes/maxBytes * plotH = plotTop + plotH * (1 - bytes/maxBytes)
  // clip_y = 1 - 2 * pixel_y / canvasH
  //        = 1 - 2*(plotTop + plotH)/canvasH + 2*plotH*bytes/(maxBytes*canvasH)
  const yScale = (2 * plotH) / (canvasH * maxBytes);
  const yOffset = 1 - (2 * (plotTop + plotH)) / canvasH;

  gl.uniform2f(uXTf, xScale, xOffset);
  gl.uniform2f(uYTf, yScale, yOffset);

  const ext = (gl as any)._ext as ANGLE_instanced_arrays;
  ext.drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, instanceCount);

  gl.disable(gl.SCISSOR_TEST);
}
