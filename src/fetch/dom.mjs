import { JSDOM, ResourceLoader, VirtualConsole } from "jsdom";
import { CookieJar } from "tough-cookie";
import {
  installDatadog,
  installGraphics,
  installWebSocket,
} from "./emulation.mjs";

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Experimental DOM only: no browser, browser transport, or synthetic gestures.
// HTTP requests and the narrowly allowed Iovation WebSocket use bounded transports.
export class FetchDOM {
  constructor({ request, jar = new CookieJar(), userAgent }) {
    this.request = request;
    this.jar = jar;
    this.userAgent = userAgent;
    this.windows = [];
    this.pending = new Set();
    this.errors = [];
    this.storage = new Map();
    this.submissions = [];
    this.frames = [];
  }
  track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  async settle(ms = 3000) {
    await pause(ms);
    for (let n = 0; n < 20 && this.pending.size; n++) {
      await Promise.allSettled(this.pending);
      await pause(100);
    }
  }
  install(window) {
    const owner = this;
    let loaded = false;
    window.addEventListener(
      "load",
      (event) => {
        if (event.target !== window.document) return;
        if (loaded) event.stopImmediatePropagation();
        loaded = true;
      },
      true,
    );
    // jsdom implements neither canvas nor WebGL nor the Datadog SDK, and disables
    // WebSockets; the login protection runtime uses all of them. Provide
    // deterministic surfaces so the sensor payload, the ulp-dd-session-id field,
    // and the Iovation fingerprint populate as they do in a browser.
    installGraphics(window);
    installDatadog(window);
    installWebSocket(window, {
      track: (promise) => owner.track(promise),
      allow: (url) =>
        url.protocol === "wss:" && url.hostname === "mpsnare.iesnare.com",
      userAgent: owner.userAgent,
      cookieFor: (url) => {
        try {
          return owner.jar.getCookieStringSync(url.href);
        } catch {
          return "";
        }
      },
    });
    const write = window.document.write.bind(window.document);
    window.document.write = (...parts) => {
      // The vendor bootstrap removes currentScript before document.write().
      // jsdom's insertion point otherwise refers to a detached element.
      if (
        window.document.currentScript &&
        !window.document.currentScript.parentNode
      ) {
        const fragment = window.document.createElement("template");
        fragment.innerHTML = parts.join("");
        for (const node of fragment.content.childNodes) {
          if (node.nodeName === "SCRIPT") {
            const script = window.document.createElement("script");
            for (const attr of node.attributes)
              script.setAttribute(attr.name, attr.value);
            script.textContent = node.textContent;
            window.document.head.appendChild(script);
          }
        }
      } else write(...parts);
    };
    window.__configureChild = (child) => owner.install(child);
    if (window.parent !== window) {
      const parent = window.parent;
      const frame = {
        origin: window.location.origin,
        referrerOrigin: window.document.referrer
          ? new URL(window.document.referrer).origin
          : null,
        messages: [],
      };
      this.frames.push(frame);
      window.addEventListener("message", (event) =>
        frame.messages.push({
          origin: event.origin,
          type: typeof event.data,
          id: (() => {
            try {
              return JSON.parse(event.data).id;
            } catch {
              return null;
            }
          })(),
        }),
      );
      const deliver = (target, source, data, targetOrigin) => {
        let origin =
          typeof targetOrigin === "object"
            ? targetOrigin.targetOrigin
            : targetOrigin;
        if (origin !== "*")
          origin = new URL(origin, source.location.href).origin;
        if (origin !== "*" && origin !== target.location.origin) return;
        window.setTimeout(
          () =>
            target.dispatchEvent(
              new target.MessageEvent("message", {
                data,
                origin: source.location.origin,
                source,
              }),
            ),
          0,
        );
      };
      // jsdom's postMessage leaves origin/source empty; preserve the real frame origins.
      window.postMessage = (data, origin) =>
        deliver(window, parent, data, origin);
      Object.defineProperty(window, "parent", {
        value: new Proxy(parent, {
          get(target, key) {
            return key === "postMessage"
              ? (data, origin) => deliver(parent, window, data, origin)
              : Reflect.get(target, key);
          },
        }),
      });
    }
    window.fetch = (input, init = {}) =>
      owner.track(
        (async () => {
          const request =
            input && typeof input.url === "string" ? input : undefined;
          const inherited = request
            ? {
                method: request.method,
                headers: request.headers,
                credentials: request.credentials,
                redirect: request.redirect,
                signal: request.signal,
                ...(request.body && init.body === undefined
                  ? { body: await request.text() }
                  : {}),
              }
            : {};
          return owner.request(
            new URL(request?.url ?? String(input), window.location.href),
            {
              ...inherited,
              ...init,
              referer: window.location.href,
              origin: window.location.origin,
            },
          );
        })(),
      );
    window.navigator.sendBeacon = (url, body) => {
      window
        .fetch(url, {
          method: "POST",
          body,
          headers: { "content-type": "text/plain;charset=UTF-8" },
        })
        .catch(() => {});
      return true;
    };
    window.XMLHttpRequest = class extends window.EventTarget {
      readyState = 0;
      status = 0;
      responseText = "";
      response = "";
      responseType = "";
      headers = {};
      onload = null;
      onerror = null;
      onabort = null;
      ontimeout = null;
      onreadystatechange = null;
      open(method, url, async = true) {
        if (!async)
          throw new Error("Synchronous XHR unavailable in fetch experiment");
        this.method = method.toUpperCase();
        this.url = new URL(url, window.location.href);
        this.readyState = 1;
      }
      setRequestHeader(key, value) {
        this.headers[key] = value;
      }
      overrideMimeType() {}
      getResponseHeader(key) {
        return this.responseHeaders?.get(key) ?? null;
      }
      getAllResponseHeaders() {
        return [...(this.responseHeaders ?? [])]
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
      }
      abort() {
        this.controller?.abort();
      }
      emit(name) {
        const event = new window.Event(name);
        this[`on${name}`]?.(event);
        this.dispatchEvent(event);
      }
      send(body) {
        this.controller = new AbortController();
        owner.track(
          (async () => {
            try {
              const res = await window.fetch(this.url, {
                method: this.method,
                headers: this.headers,
                body,
                signal: this.controller.signal,
              });
              this.status = res.status;
              this.responseHeaders = res.headers;
              this.readyState = 2;
              this.emit("readystatechange");
              this.responseText = await res.text();
              this.response =
                this.responseType === "json"
                  ? JSON.parse(this.responseText)
                  : this.responseText;
              this.readyState = 4;
              this.emit("readystatechange");
              this.emit("load");
              this.emit("loadend");
            } catch {
              this.readyState = 4;
              this.emit("error");
              this.emit("loadend");
            }
          })(),
        );
      }
    };
    const origin = window.location.origin;
    if (origin !== "null") {
      for (const kind of ["localStorage", "sessionStorage"]) {
        const key = `${origin}/${kind}`;
        if (this.storage.has(key))
          Object.defineProperty(window, kind, { value: this.storage.get(key) });
        else this.storage.set(key, window[kind]);
      }
    }
    window.HTMLFormElement.prototype.submit = function () {
      owner.submissions.push({
        url: this.action,
        fields: new URLSearchParams([...new window.FormData(this)]),
      });
    };
  }
  open(html, url, beforeParse) {
    const owner = this;
    class Loader extends ResourceLoader {
      fetch(target, options) {
        if (
          options.element?.localName === "link" ||
          options.element?.localName === "img"
        )
          return null;
        const promise = owner.track(
          (async () => {
            const response = await owner.request(new URL(target), {
              referer: options.referrer,
              resource: options.element?.localName,
            });
            let content = await response.text();
            if (options.element?.localName === "iframe")
              content = content.replace(
                /<head>/i,
                "<head><script>parent.__configureChild(window)</script>",
              );
            return Buffer.from(content);
          })(),
        );
        promise.abort = () => {};
        return promise;
      }
    }
    const console = new VirtualConsole();
    console.on("jsdomError", (error) => {
      const record = {
        type: error.type,
        message: String(error.message)
          .replace(/https?:\/\/\S+/g, "<url>")
          .slice(0, 160),
      };
      if (
        !this.errors.some(
          (e) => e.type === record.type && e.message === record.message,
        )
      )
        this.errors.push(record);
    });
    const dom = new JSDOM(html, {
      url,
      cookieJar: this.jar,
      pretendToBeVisual: true,
      runScripts: "dangerously",
      resources: new Loader({ userAgent: this.userAgent }),
      virtualConsole: console,
      beforeParse: (window) => {
        this.install(window);
        beforeParse?.(window);
      },
    });
    this.windows.push(dom.window);
    return dom.window;
  }
  close() {
    for (const window of this.windows) window.close();
  }
}
