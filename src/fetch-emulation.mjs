// `ws` ships with jsdom; unlike Node's global WebSocket it lets us set the Origin
// header the Iovation endpoint requires, while exposing the browser event API.
import { WebSocket as NodeWebSocket } from "ws";

// Browser surfaces jsdom does not implement but the login protection runtime probes.
// These are deterministic, Chrome-on-macOS-shaped shims: enough for the sensor and
// fingerprint sections to populate instead of collapsing to nothing. They render no
// real pixels and open no browser; graphics values are canned, realtime is delegated
// to the caller's allowlist.

// A small but valid PNG so toDataURL() returns image bytes the sensor can hash.
const CANVAS_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c" +
  "6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAENSURBVDhPjZKxTsMwEIb/c" +
  "2ynSZM2KQMDCxMTC4/AwsbGwsLGwMDAwMDAwMDAwMDGwMDAwMDAwMDAwMDAwMDAxMDAwMDAwMDA5g" +
  "kSJ07i2Elq/kmW7Lu7T3ffnQ0iwgIiFAKgBGAA0AVQBVAA0AJQBnAGcAZwB3AHcAdwB3AHcAdwBn" +
  "AGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcA" +
  "ZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwBnAGcAZwB3AAAAAElFTkSuQmCC";

// WebGL constants the debug/renderer fingerprint reads, name -> enum value.
const GL_CONST = {
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  RED_BITS: 0x0d52,
  GREEN_BITS: 0x0d53,
  BLUE_BITS: 0x0d54,
  ALPHA_BITS: 0x0d55,
  DEPTH_BITS: 0x0d56,
  STENCIL_BITS: 0x0d57,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  HIGH_FLOAT: 0x8df2,
  MEDIUM_FLOAT: 0x8df1,
  LOW_FLOAT: 0x8df0,
  HIGH_INT: 0x8df5,
  MEDIUM_INT: 0x8df4,
  LOW_INT: 0x8df3,
};

// enum value -> reported getParameter() result.
const GL_VALUES = {
  0x1f00: "WebKit",
  0x1f01: "WebKit WebGL",
  0x1f02: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
  0x8b8c: "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
  0x9245: "Google Inc. (Apple)",
  0x9246:
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
  0x0d52: 8,
  0x0d53: 8,
  0x0d54: 8,
  0x0d55: 8,
  0x0d56: 24,
  0x0d57: 0,
  0x0d33: 16384,
  0x851c: 16384,
  0x84e8: 16384,
  0x8869: 16,
  0x8dfb: 1024,
  0x8dfc: 31,
  0x8dfd: 1024,
  0x8872: 16,
  0x8b4c: 16,
  0x8b4d: 32,
  0x84ff: 16,
};

const GL_EXTENSIONS = [
  "ANGLE_instanced_arrays",
  "EXT_blend_minmax",
  "EXT_color_buffer_half_float",
  "EXT_float_blend",
  "EXT_frag_depth",
  "EXT_shader_texture_lod",
  "EXT_texture_compression_bptc",
  "EXT_texture_compression_rgtc",
  "EXT_texture_filter_anisotropic",
  "OES_element_index_uint",
  "OES_fbo_render_mipmap",
  "OES_standard_derivatives",
  "OES_texture_float",
  "OES_texture_float_linear",
  "OES_texture_half_float",
  "OES_texture_half_float_linear",
  "OES_vertex_array_object",
  "WEBGL_color_buffer_float",
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb",
  "WEBGL_debug_renderer_info",
  "WEBGL_debug_shaders",
  "WEBGL_depth_texture",
  "WEBGL_lose_context",
  "WEBGL_multi_draw",
];

function make2dContext(canvas, window) {
  const noop = () => {};
  const state = {
    canvas,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "10px sans-serif",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    textAlign: "start",
    textBaseline: "alphabetic",
    direction: "ltr",
  };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      switch (key) {
        case "measureText":
          return (text) => {
            const width = String(text ?? "").length * 7.2333;
            return {
              width,
              actualBoundingBoxLeft: 0,
              actualBoundingBoxRight: width,
              actualBoundingBoxAscent: 8,
              actualBoundingBoxDescent: 2,
              fontBoundingBoxAscent: 9,
              fontBoundingBoxDescent: 2,
              emHeightAscent: 9,
              emHeightDescent: 2,
              hangingBaseline: 8,
              alphabeticBaseline: 0,
              ideographicBaseline: -2,
            };
          };
        case "getImageData":
          return (_x, _y, w = 1, h = 1) => ({
            data: new window.Uint8ClampedArray(Math.max(4, w * h * 4)),
            width: w,
            height: h,
            colorSpace: "srgb",
          });
        case "createImageData":
          return (w = 1, h = 1) => ({
            data: new window.Uint8ClampedArray(Math.max(4, w * h * 4)),
            width: w,
            height: h,
            colorSpace: "srgb",
          });
        case "createLinearGradient":
        case "createRadialGradient":
        case "createConicGradient":
          return () => ({ addColorStop: noop });
        case "createPattern":
          return () => ({ setTransform: noop });
        case "getContextAttributes":
          return () => ({
            alpha: true,
            colorSpace: "srgb",
            desynchronized: false,
            willReadFrequently: false,
          });
        case "isPointInPath":
        case "isPointInStroke":
          return () => false;
        case "getLineDash":
          return () => [];
        default:
          return noop;
      }
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

function makeWebGLContext(canvas) {
  const noop = () => {};
  const base = {
    canvas,
    drawingBufferWidth: canvas.width || 300,
    drawingBufferHeight: canvas.height || 150,
    drawingBufferColorSpace: "srgb",
    ...GL_CONST,
    getParameter(pname) {
      if (pname === 0x0d3a) return new Int32Array([16384, 16384]);
      if (pname === 0x846e) return new Float32Array([1, 1]);
      if (pname === 0x846d) return new Float32Array([1, 1024]);
      const value = GL_VALUES[pname];
      return value === undefined ? 0 : value;
    },
    getExtension(name) {
      if (name === "WEBGL_debug_renderer_info")
        return {
          UNMASKED_VENDOR_WEBGL: 0x9245,
          UNMASKED_RENDERER_WEBGL: 0x9246,
        };
      if (name === "EXT_texture_filter_anisotropic")
        return {
          MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
          TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
        };
      if (name === "WEBGL_lose_context")
        return { loseContext: noop, restoreContext: noop };
      if (name === "OES_vertex_array_object")
        return {
          createVertexArrayOES: () => ({}),
          bindVertexArrayOES: noop,
          deleteVertexArrayOES: noop,
          isVertexArrayOES: () => false,
          VERTEX_ARRAY_BINDING_OES: 0x85b5,
        };
      return GL_EXTENSIONS.includes(name) ? {} : null;
    },
    getSupportedExtensions() {
      return [...GL_EXTENSIONS];
    },
    getShaderPrecisionFormat() {
      return { rangeMin: 127, rangeMax: 127, precision: 23 };
    },
    getContextAttributes() {
      return {
        alpha: true,
        antialias: true,
        depth: true,
        desynchronized: false,
        failIfMajorPerformanceCaveat: false,
        powerPreference: "default",
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        stencil: false,
        xrCompatible: false,
      };
    },
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getProgramInfoLog: () => "",
    getShaderInfoLog: () => "",
    checkFramebufferStatus: () => 0x8cd5,
    isEnabled: () => false,
    isContextLost: () => false,
    readPixels: noop,
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      // Unknown WebGL enum reads resolve to 0; unknown calls become no-ops.
      return typeof key === "string" && /^[A-Z0-9_]+$/.test(key) ? 0 : noop;
    },
  });
}

/** Give canvases a 2D and WebGL fingerprinting surface. */
export function installGraphics(window) {
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function getContext(type) {
    if (type === "2d") return make2dContext(this, window);
    if (type === "webgl" || type === "experimental-webgl" || type === "webgl2")
      return makeWebGLContext(this);
    return null;
  };
  proto.toDataURL = function toDataURL() {
    return CANVAS_PNG;
  };
  proto.toBlob = function toBlob(callback) {
    callback?.(new window.Blob([CANVAS_PNG], { type: "image/png" }));
  };
}

// A UUID the Datadog RUM session field is filled from.
function uuid() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * Stub the Datadog RUM SDK the auth page reads `ulp-dd-session-id` from.
 * The real script is blocked, so without this the field is left empty.
 */
export function installDatadog(window) {
  const sessionId = uuid();
  const context = {
    application_id: undefined,
    session_id: sessionId,
    user_activity: {},
  };
  const ready = [];
  const rum = {
    version: "6.0.0",
    onReady(callback) {
      if (typeof callback === "function") ready.push(callback);
      queueMicrotask(() => {
        while (ready.length) ready.shift()();
      });
    },
    init() {},
    getInternalContext() {
      return context;
    },
    getInitConfiguration() {
      return {};
    },
    setGlobalContextProperty() {},
    setGlobalContext() {},
    getGlobalContext() {
      return {};
    },
    addAction() {},
    addError() {},
    addTiming() {},
    setUser() {},
    getUser() {
      return {};
    },
    setUserProperty() {},
    removeUserProperty() {},
    clearUser() {},
    startView() {},
    startSessionReplayRecording() {},
    stopSessionReplayRecording() {},
    stopSession() {},
    getSessionReplayLink() {
      return undefined;
    },
  };
  window.DD_RUM = rum;
  window.DD_LOGS = {
    onReady(callback) {
      if (typeof callback === "function") callback();
    },
    init() {},
    logger: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    setGlobalContextProperty() {},
  };
  return sessionId;
}

/**
 * Give the page a real WebSocket, restricted to the Iovation endpoint the browser
 * uses (`wss://mpsnare.iesnare.com/star`). The device-fingerprint runtime opens it
 * and folds the server's reply into the fingerprint; without it that data is absent.
 * Every other WebSocket destination is refused.
 */
export function installWebSocket(
  window,
  { track, allow, userAgent, cookieFor },
) {
  class BoundedWebSocket extends NodeWebSocket {
    constructor(url, protocols) {
      const target = new URL(String(url), window.location.href);
      if (!allow(target))
        throw new window.DOMException(
          "WebSocket destination not permitted",
          "SecurityError",
        );
      const cookie = cookieFor?.(target) || "";
      super(target.href, protocols, {
        origin: window.location.origin,
        headers: {
          "user-agent": userAgent,
          ...(cookie ? { cookie } : {}),
        },
      });
      // Keep the DOM settle loop open until the handshake and any reply finish.
      const settled = new Promise((resolve) => {
        this.addEventListener("close", resolve, { once: true });
        this.addEventListener("error", resolve, { once: true });
        setTimeout(resolve, 8000);
      });
      track(settled);
    }
  }
  window.WebSocket = BoundedWebSocket;
}
