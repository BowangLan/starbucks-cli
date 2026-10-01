// Synthetic website scripts. No captured code, credentials, cookies, or proof values.
export function contextFixture(input) {
  const url = new URL(String(input));
  if (url.origin === "https://www.starbucks.com" && url.pathname === "/") return new Response("<!doctype html>");
  if (url.pathname === "/vendor/static/vendor2.js") return new Response(`
    // init("fixture-bootstrap")
    const originalSubmit = HTMLFormElement.prototype.submit;
    let sequence = 0;
    HTMLFormElement.prototype.submit = function () {
      for (const suffix of ['a', 'b', 'c', 'd', 'f', 'z']) {
        const field = document.createElement('input');
        field.name = 'X-DQ7Hy5L1-' + suffix;
        field.value = suffix === 'f' ? 'fixture-bootstrap' : 'fresh-' + (++sequence);
        this.appendChild(field);
      }
      originalSubmit.call(this);
    };
  `);
  if (url.origin === "https://prod.accdab.net" && url.pathname.startsWith("/cdn/cs/")) return new Response(`
    window._bcn = { getToken() { return 'fixture-current-risk'; }, flush() {} };
    fetch('https://prod.accdab.net/beacon/gt', { method: 'POST', body: '{}' });
  `);
  if (url.pathname === "/weblx/assets/iovation-first-third.js") return new Response(`window.IGLOO.bb_callback('fixture-current-fingerprint', true);`);
  if (url.origin === "https://prod.accdab.net" && url.pathname === "/beacon/gt") return Response.json({});
}
