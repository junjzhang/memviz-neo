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


/**
 * Upload a pre-packed strip buffer to the GPU.
 * Zero JS iteration — buffer is built once at load time in fileStore.
 */
export function uploadStrips(
  state: GLState,
  stripBuffer: Float32Array,
  stripCount: number,
) {
  const { gl, instanceVBO } = state;
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
  gl.bufferData(gl.ARRAY_BUFFER, stripBuffer, gl.STATIC_DRAW);
  state.instanceCount = stripCount;
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
  yMin: number,
  yMax: number,
  timeOrigin: number,
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

  // Strip time values are pre-normalized (t - timeOrigin). We must normalize
  // tMin/tMax the same way, otherwise subtraction below happens in Float32
  // with absolute Unix timestamps and collapses the entire range.
  const tMinN = tMin - timeOrigin;
  const tMaxN = tMax - timeOrigin;

  // clip_x = (tN - tMinN) / (tMaxN - tMinN) * (2 * plotW / canvasW) + (2 * plotLeft / canvasW - 1)
  const xScale = (2 * plotW) / (canvasW * (tMaxN - tMinN));
  const xOffset = (2 * plotLeft) / canvasW - 1 - tMinN * xScale;

  // Map [yMin, yMax] → plot-area clip range. bytes * yScale + yOffset.
  const ySpan = yMax - yMin;
  const yScale = (2 * plotH) / (canvasH * ySpan);
  const yOffset = 1 - (2 * (plotTop + plotH)) / canvasH - yMin * yScale;

  gl.uniform2f(uXTf, xScale, xOffset);
  gl.uniform2f(uYTf, yScale, yOffset);

  const ext = (gl as any)._ext as ANGLE_instanced_arrays;
  ext.drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, instanceCount);

  gl.disable(gl.SCISSOR_TEST);
}
