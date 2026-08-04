import { useEffect, useRef } from "react";

/**
 * Splash cursor — a fluid simulation that the pointer stirs.
 *
 * Adapted from React Bits' "Splash Cursor"
 * (https://reactbits.dev/animations/splash-cursor, MIT), itself derived from
 * Pavel Dobryakov's WebGL-Fluid-Simulation (MIT). The Navier–Stokes solver
 * below — curl, vorticity, divergence, Jacobi pressure, advection — is that
 * lineage. What is ours: strict typing, WebGL2-only, the cyan-locked palette,
 * an intensity low enough to read as atmosphere, teardown that actually
 * releases the context, and a loop that stops when the fluid has settled.
 *
 * Landing only. Inside the wallet nothing loops at rest.
 *
 * Gating (touch, reduced motion, first paint) lives in SplashCursorLayer —
 * this module is the payload it lazy-loads, so none of it is fetched on a
 * device that will not run it.
 */

/**
 * Tuned down from the reference, in this order: dye resolution and density
 * dissipation first (the two that cost frames), then intensity. The default
 * config is built to be the whole page; here it shares one with a starfield,
 * two orbs and backdrop-blurred glass, and it sits *behind* the content plane.
 */
const CONFIG = {
  /** Velocity/pressure grid. The visible softness comes from DYE, not this. */
  SIM_RESOLUTION: 96,
  /** Colour grid. 1440 in the reference — three times the fill rate we need. */
  DYE_RESOLUTION: 512,
  /** How fast colour fades. High, so the trail is a wake and not a painting. */
  DENSITY_DISSIPATION: 4.5,
  VELOCITY_DISSIPATION: 2.6,
  PRESSURE: 0.1,
  PRESSURE_ITERATIONS: 16,
  /** Swirl. Lower than the reference: eddies, not curls. */
  CURL: 2.5,
  SPLAT_RADIUS: 0.16,
  SPLAT_FORCE: 5000,
  SHADING: true,
  /**
   * Master brightness. The display shader derives alpha from the brightest
   * channel, so this is also the trail's peak opacity — 0.16 keeps it under
   * the text that floats above it.
   */
  INTENSITY: 0.16,
  /** A click blooms, but only just. */
  CLICK_GAIN: 2.2,
  /** Stop simulating this long after the last pointer movement. */
  IDLE_MS: 2000,
} as const;

/**
 * Cyan, always. The reference cycles the full hue wheel; Sombra has one accent
 * and this is it. 0.524 is #38E2FF in HSV — the window is narrow enough that
 * the fluid never leaves the brand, wide enough that it is not flat.
 */
function brandColor(): RGB {
  const hue = 0.5 + Math.random() * 0.06;
  const c = hsvToRgb(hue, 0.7 + Math.random() * 0.25, 0.75 + Math.random() * 0.25);
  return { r: c.r * CONFIG.INTENSITY, g: c.g * CONFIG.INTENSITY, b: c.b * CONFIG.INTENSITY };
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Pointer {
  texcoordX: number;
  texcoordY: number;
  prevTexcoordX: number;
  prevTexcoordY: number;
  deltaX: number;
  deltaY: number;
  moved: boolean;
  color: RGB;
}

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  attach(id: number): number;
}

interface DoubleFBO {
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  read: FBO;
  write: FBO;
  swap(): void;
}

interface TexFormat {
  internalFormat: number;
  format: number;
}

export default function SplashCursor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // WebGL2 only. The WebGL1 half-float path doubles the size of this file for
    // browsers we do not ship to, and a missing context here costs the page an
    // accent, not a feature.
    const glMaybe = canvas.getContext("webgl2", {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!glMaybe) return;
    // Definite alias: narrowing does not survive into the classes below.
    const gl: WebGL2RenderingContext = glMaybe;

    gl.getExtension("EXT_color_buffer_float");
    const linearFiltering = !!gl.getExtension("OES_texture_float_linear");
    const halfFloat = gl.HALF_FLOAT;

    /* ---------------------------------------------------------------- setup */

    const supportsFormat = (
      internalFormat: number,
      format: number,
      type: number,
    ): boolean => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(texture);
      return ok;
    };

    /** Falls back up the channel count until the driver accepts one. */
    const getFormat = (
      internalFormat: number,
      format: number,
      type: number,
    ): TexFormat | null => {
      if (supportsFormat(internalFormat, format, type)) {
        return { internalFormat, format };
      }
      if (internalFormat === gl.R16F) return getFormat(gl.RG16F, gl.RG, type);
      if (internalFormat === gl.RG16F) return getFormat(gl.RGBA16F, gl.RGBA, type);
      return null;
    };

    const formatRGBA = getFormat(gl.RGBA16F, gl.RGBA, halfFloat);
    const formatRG = getFormat(gl.RG16F, gl.RG, halfFloat);
    const formatR = getFormat(gl.R16F, gl.RED, halfFloat);
    if (!formatRGBA || !formatRG || !formatR) return;

    const compile = (type: number, source: string, keywords?: string[]) => {
      const prefix = keywords?.map((k) => `#define ${k}\n`).join("") ?? "";
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, prefix + source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn(gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    class Program {
      readonly program: WebGLProgram;
      readonly uniforms: Record<string, WebGLUniformLocation | null> = {};

      constructor(vertex: WebGLShader, fragment: WebGLShader) {
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertex);
        gl.attachShader(this.program, fragment);
        gl.linkProgram(this.program);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
          console.warn(gl.getProgramInfoLog(this.program));
        }
        const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS) as number;
        for (let i = 0; i < count; i++) {
          const info = gl.getActiveUniform(this.program, i);
          if (info) this.uniforms[info.name] = gl.getUniformLocation(this.program, info.name);
        }
      }

      bind() {
        gl.useProgram(this.program);
      }
    }

    /* -------------------------------------------------------------- shaders */

    const baseVertex = compile(
      gl.VERTEX_SHADER,
      `precision highp float;
       attribute vec2 aPosition;
       varying vec2 vUv, vL, vR, vT, vB;
       uniform vec2 texelSize;
       void main () {
         vUv = aPosition * 0.5 + 0.5;
         vL = vUv - vec2(texelSize.x, 0.0);
         vR = vUv + vec2(texelSize.x, 0.0);
         vT = vUv + vec2(0.0, texelSize.y);
         vB = vUv - vec2(0.0, texelSize.y);
         gl_Position = vec4(aPosition, 0.0, 1.0);
       }`,
    );

    const clearFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv;
       uniform sampler2D uTexture;
       uniform float value;
       void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`,
    );

    // Alpha is the brightest channel, and the canvas blends premultiplied — so
    // the dye tints what is behind it instead of painting over it.
    const displayFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision highp float;
       precision highp sampler2D;
       varying vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uTexture;
       uniform vec2 texelSize;
       void main () {
         vec3 c = texture2D(uTexture, vUv).rgb;
         #ifdef SHADING
           float dx = length(texture2D(uTexture, vR).rgb) - length(texture2D(uTexture, vL).rgb);
           float dy = length(texture2D(uTexture, vT).rgb) - length(texture2D(uTexture, vB).rgb);
           vec3 n = normalize(vec3(dx, dy, length(texelSize)));
           c *= clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
         #endif
         gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
       }`,
      CONFIG.SHADING ? ["SHADING"] : undefined,
    );

    const splatFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision highp float;
       precision highp sampler2D;
       varying vec2 vUv;
       uniform sampler2D uTarget;
       uniform float aspectRatio;
       uniform vec3 color;
       uniform vec2 point;
       uniform float radius;
       void main () {
         vec2 p = vUv - point.xy;
         p.x *= aspectRatio;
         vec3 splat = exp(-dot(p, p) / radius) * color;
         gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
       }`,
    );

    const advectionFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision highp float;
       precision highp sampler2D;
       varying vec2 vUv;
       uniform sampler2D uVelocity;
       uniform sampler2D uSource;
       uniform vec2 texelSize;
       uniform vec2 dyeTexelSize;
       uniform float dt;
       uniform float dissipation;

       vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
         vec2 st = uv / tsize - 0.5;
         vec2 iuv = floor(st);
         vec2 fuv = fract(st);
         vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
         vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
         vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
         vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
         return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
       }

       void main () {
         #ifdef MANUAL_FILTERING
           vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
           vec4 result = bilerp(uSource, coord, dyeTexelSize);
         #else
           vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
           vec4 result = texture2D(uSource, coord);
         #endif
         gl_FragColor = result / (1.0 + dissipation * dt);
       }`,
      linearFiltering ? undefined : ["MANUAL_FILTERING"],
    );

    const divergenceFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uVelocity;
       void main () {
         float L = texture2D(uVelocity, vL).x;
         float R = texture2D(uVelocity, vR).x;
         float T = texture2D(uVelocity, vT).y;
         float B = texture2D(uVelocity, vB).y;
         vec2 C = texture2D(uVelocity, vUv).xy;
         if (vL.x < 0.0) { L = -C.x; }
         if (vR.x > 1.0) { R = -C.x; }
         if (vT.y > 1.0) { T = -C.y; }
         if (vB.y < 0.0) { B = -C.y; }
         gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
       }`,
    );

    const curlFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uVelocity;
       void main () {
         float L = texture2D(uVelocity, vL).y;
         float R = texture2D(uVelocity, vR).y;
         float T = texture2D(uVelocity, vT).x;
         float B = texture2D(uVelocity, vB).x;
         gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
       }`,
    );

    const vorticityFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision highp float;
       precision highp sampler2D;
       varying vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uVelocity;
       uniform sampler2D uCurl;
       uniform float curl;
       uniform float dt;
       void main () {
         float L = texture2D(uCurl, vL).x;
         float R = texture2D(uCurl, vR).x;
         float T = texture2D(uCurl, vT).x;
         float B = texture2D(uCurl, vB).x;
         float C = texture2D(uCurl, vUv).x;
         vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
         force /= length(force) + 0.0001;
         force *= curl * C;
         force.y *= -1.0;
         vec2 velocity = texture2D(uVelocity, vUv).xy + force * dt;
         gl_FragColor = vec4(min(max(velocity, -1000.0), 1000.0), 0.0, 1.0);
       }`,
    );

    const pressureFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uPressure;
       uniform sampler2D uDivergence;
       void main () {
         float L = texture2D(uPressure, vL).x;
         float R = texture2D(uPressure, vR).x;
         float T = texture2D(uPressure, vT).x;
         float B = texture2D(uPressure, vB).x;
         float divergence = texture2D(uDivergence, vUv).x;
         gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
       }`,
    );

    const gradientSubtractFrag = compile(
      gl.FRAGMENT_SHADER,
      `precision mediump float;
       precision mediump sampler2D;
       varying highp vec2 vUv, vL, vR, vT, vB;
       uniform sampler2D uPressure;
       uniform sampler2D uVelocity;
       void main () {
         float L = texture2D(uPressure, vL).x;
         float R = texture2D(uPressure, vR).x;
         float T = texture2D(uPressure, vT).x;
         float B = texture2D(uPressure, vB).x;
         vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
         gl_FragColor = vec4(velocity, 0.0, 1.0);
       }`,
    );

    const shaders = [
      baseVertex,
      clearFrag,
      displayFrag,
      splatFrag,
      advectionFrag,
      divergenceFrag,
      curlFrag,
      vorticityFrag,
      pressureFrag,
      gradientSubtractFrag,
    ];
    if (shaders.some((s) => s === null)) return;

    const vert = baseVertex as WebGLShader;
    const clearProgram = new Program(vert, clearFrag as WebGLShader);
    const displayProgram = new Program(vert, displayFrag as WebGLShader);
    const splatProgram = new Program(vert, splatFrag as WebGLShader);
    const advectionProgram = new Program(vert, advectionFrag as WebGLShader);
    const divergenceProgram = new Program(vert, divergenceFrag as WebGLShader);
    const curlProgram = new Program(vert, curlFrag as WebGLShader);
    const vorticityProgram = new Program(vert, vorticityFrag as WebGLShader);
    const pressureProgram = new Program(vert, pressureFrag as WebGLShader);
    const gradientSubtractProgram = new Program(vert, gradientSubtractFrag as WebGLShader);

    /* ------------------------------------------------------------ full quad */

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const quadIndices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    const blit = (target: FBO | null) => {
      if (target === null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };

    /* ---------------------------------------------------------- framebuffers */

    const createFBO = (
      w: number,
      h: number,
      internalFormat: number,
      format: number,
      param: number,
    ): FBO => {
      gl.activeTexture(gl.TEXTURE0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, halfFloat, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX: 1 / w,
        texelSizeY: 1 / h,
        attach(id: number) {
          gl.activeTexture(gl.TEXTURE0 + id);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          return id;
        },
      };
    };

    const createDoubleFBO = (
      w: number,
      h: number,
      internalFormat: number,
      format: number,
      param: number,
    ): DoubleFBO => {
      const target: DoubleFBO = {
        width: w,
        height: h,
        texelSizeX: 1 / w,
        texelSizeY: 1 / h,
        read: createFBO(w, h, internalFormat, format, param),
        write: createFBO(w, h, internalFormat, format, param),
        swap() {
          const tmp = target.read;
          target.read = target.write;
          target.write = tmp;
        },
      };
      return target;
    };

    const resolutionFor = (base: number) => {
      const buffer = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const aspect = buffer < 1 ? 1 / buffer : buffer;
      const min = Math.round(base);
      const max = Math.round(base * aspect);
      return gl.drawingBufferWidth > gl.drawingBufferHeight
        ? { width: max, height: min }
        : { width: min, height: max };
    };

    const filtering = linearFiltering ? gl.LINEAR : gl.NEAREST;
    let dye: DoubleFBO;
    let velocity: DoubleFBO;
    let divergence: FBO;
    let curlField: FBO;
    let pressure: DoubleFBO;

    const disposeDouble = (t: DoubleFBO) => {
      for (const f of [t.read, t.write]) {
        gl.deleteFramebuffer(f.fbo);
        gl.deleteTexture(f.texture);
      }
    };
    const disposeSingle = (f: FBO) => {
      gl.deleteFramebuffer(f.fbo);
      gl.deleteTexture(f.texture);
    };

    /**
     * Rebuilt wholesale on resize rather than blitting the old dye into the new
     * size: the trail is gone within half a second anyway, so preserving it
     * across a window drag buys nothing and costs a copy path.
     */
    const initFramebuffers = () => {
      const sim = resolutionFor(CONFIG.SIM_RESOLUTION);
      const dyeRes = resolutionFor(CONFIG.DYE_RESOLUTION);
      gl.disable(gl.BLEND);

      if (dye) disposeDouble(dye);
      if (velocity) disposeDouble(velocity);
      if (divergence) disposeSingle(divergence);
      if (curlField) disposeSingle(curlField);
      if (pressure) disposeDouble(pressure);

      dye = createDoubleFBO(
        dyeRes.width,
        dyeRes.height,
        formatRGBA.internalFormat,
        formatRGBA.format,
        filtering,
      );
      velocity = createDoubleFBO(
        sim.width,
        sim.height,
        formatRG.internalFormat,
        formatRG.format,
        filtering,
      );
      divergence = createFBO(
        sim.width,
        sim.height,
        formatR.internalFormat,
        formatR.format,
        gl.NEAREST,
      );
      curlField = createFBO(
        sim.width,
        sim.height,
        formatR.internalFormat,
        formatR.format,
        gl.NEAREST,
      );
      pressure = createDoubleFBO(
        sim.width,
        sim.height,
        formatR.internalFormat,
        formatR.format,
        gl.NEAREST,
      );
    };

    const scaleByPixelRatio = (input: number) =>
      Math.floor(input * (window.devicePixelRatio || 1));

    const resizeCanvas = () => {
      // Capped at 2: the sim is fill-rate bound and a 3x retina buffer triples
      // the cost of every pass for an effect nobody is looking straight at.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.floor(canvas.clientWidth * dpr);
      const height = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        return true;
      }
      return false;
    };

    resizeCanvas();
    initFramebuffers();

    /* ------------------------------------------------------------------ sim */

    const step = (dt: number) => {
      gl.disable(gl.BLEND);

      curlProgram.bind();
      gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
      blit(curlField);

      vorticityProgram.bind();
      gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(vorticityProgram.uniforms.uCurl, curlField.attach(1));
      gl.uniform1f(vorticityProgram.uniforms.curl, CONFIG.CURL);
      gl.uniform1f(vorticityProgram.uniforms.dt, dt);
      blit(velocity.write);
      velocity.swap();

      divergenceProgram.bind();
      gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
      blit(divergence);

      clearProgram.bind();
      gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
      gl.uniform1f(clearProgram.uniforms.value, CONFIG.PRESSURE);
      blit(pressure.write);
      pressure.swap();

      pressureProgram.bind();
      gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
      for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
      }

      gradientSubtractProgram.bind();
      gl.uniform2f(
        gradientSubtractProgram.uniforms.texelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      );
      gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
      gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
      blit(velocity.write);
      velocity.swap();

      advectionProgram.bind();
      gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      if (!linearFiltering) {
        gl.uniform2f(
          advectionProgram.uniforms.dyeTexelSize,
          velocity.texelSizeX,
          velocity.texelSizeY,
        );
      }
      const velocityId = velocity.read.attach(0);
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
      gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
      gl.uniform1f(advectionProgram.uniforms.dt, dt);
      gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.VELOCITY_DISSIPATION);
      blit(velocity.write);
      velocity.swap();

      if (!linearFiltering) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
      }
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
      gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.DENSITY_DISSIPATION);
      blit(dye.write);
      dye.swap();
    };

    const render = () => {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.BLEND);
      displayProgram.bind();
      if (CONFIG.SHADING) {
        gl.uniform2f(
          displayProgram.uniforms.texelSize,
          1 / gl.drawingBufferWidth,
          1 / gl.drawingBufferHeight,
        );
      }
      gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
      blit(null);
    };

    const splat = (x: number, y: number, dx: number, dy: number, color: RGB) => {
      splatProgram.bind();
      gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
      gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
      gl.uniform2f(splatProgram.uniforms.point, x, y);
      gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
      const aspect = canvas.width / canvas.height;
      const radius = CONFIG.SPLAT_RADIUS / 100;
      gl.uniform1f(splatProgram.uniforms.radius, aspect > 1 ? radius * aspect : radius);
      blit(velocity.write);
      velocity.swap();

      gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
      gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
      blit(dye.write);
      dye.swap();
    };

    /* -------------------------------------------------------------- pointer */

    const pointer: Pointer = {
      texcoordX: 0,
      texcoordY: 0,
      prevTexcoordX: 0,
      prevTexcoordY: 0,
      deltaX: 0,
      deltaY: 0,
      moved: false,
      color: brandColor(),
    };

    let lastActivity = performance.now();
    let lastUpdate = performance.now();
    let colorTimer = 0;
    let frame = 0;
    let running = false;
    let disposed = false;

    const loop = () => {
      const now = performance.now();
      let dt = (now - lastUpdate) / 1000;
      dt = Math.min(dt, 0.016666);
      lastUpdate = now;

      if (resizeCanvas()) initFramebuffers();

      // Colour drifts inside the cyan window over time, so a long stroke is not
      // one flat hue.
      colorTimer += dt * 4;
      if (colorTimer >= 1) {
        colorTimer = 0;
        pointer.color = brandColor();
      }

      if (pointer.moved) {
        pointer.moved = false;
        splat(
          pointer.texcoordX,
          pointer.texcoordY,
          pointer.deltaX * CONFIG.SPLAT_FORCE,
          pointer.deltaY * CONFIG.SPLAT_FORCE,
          pointer.color,
        );
      }

      step(dt);
      render();

      // The page is allowed to reach idle. Once the dye has dissipated and the
      // pointer has been still, we stop entirely and wait for the next move —
      // an unconditional rAF loop keeps a core warm for the whole session.
      if (now - lastActivity > CONFIG.IDLE_MS) {
        running = false;
        return;
      }
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running || disposed || document.hidden) return;
      running = true;
      lastUpdate = performance.now();
      frame = requestAnimationFrame(loop);
    };

    const onMouseMove = (e: MouseEvent) => {
      const posX = scaleByPixelRatio(e.clientX);
      const posY = scaleByPixelRatio(e.clientY);
      pointer.prevTexcoordX = pointer.texcoordX;
      pointer.prevTexcoordY = pointer.texcoordY;
      pointer.texcoordX = posX / canvas.width;
      pointer.texcoordY = 1 - posY / canvas.height;

      const aspect = canvas.width / canvas.height;
      let dx = pointer.texcoordX - pointer.prevTexcoordX;
      let dy = pointer.texcoordY - pointer.prevTexcoordY;
      if (aspect < 1) dx *= aspect;
      if (aspect > 1) dy /= aspect;
      pointer.deltaX = dx;
      pointer.deltaY = dy;
      pointer.moved = dx !== 0 || dy !== 0;

      lastActivity = performance.now();
      start();
    };

    const onMouseDown = (e: MouseEvent) => {
      const posX = scaleByPixelRatio(e.clientX);
      const posY = scaleByPixelRatio(e.clientY);
      pointer.texcoordX = posX / canvas.width;
      pointer.texcoordY = 1 - posY / canvas.height;
      const color = brandColor();
      splat(
        pointer.texcoordX,
        pointer.texcoordY,
        10 * (Math.random() - 0.5),
        30 * (Math.random() - 0.5),
        {
          r: color.r * CONFIG.CLICK_GAIN,
          g: color.g * CONFIG.CLICK_GAIN,
          b: color.b * CONFIG.CLICK_GAIN,
        },
      );
      lastActivity = performance.now();
      start();
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        running = false;
      }
      // Coming back does not restart it: the next pointer move does. A tab you
      // just switched to has nothing to animate yet.
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mousedown", onMouseDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteBuffer(quad);
      gl.deleteBuffer(quadIndices);
      // Releases every texture, framebuffer and program in one call, and tells
      // the driver the context is finished with.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-[5]" aria-hidden>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

function hsvToRgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}
