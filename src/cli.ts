#!/usr/bin/env bun
import { Command } from "commander";
import fs from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import { importCookieJar } from "./auth.js";
import { writePrivate } from "./files.js";
import { StarbucksClient, HttpTransport } from "./client.js";
import {
  createItem,
  toOrder,
  createCart,
  addItem,
  decreaseItem,
} from "./cart.js";
import type { Cart, OptionCategory } from "./types.js";
const program = new Command()
  .name("starbucks")
  .description(
    "Starbucks web SDK: browse, customize, cart, and quote. Order submission disabled.",
  )
  .version("0.1.0")
  .option(
    "--session <file>",
    "private HTTP cookie jar",
    ".starbucks/http-session.json",
  )
  .option("--cart <file>", "local SDK cart", ".starbucks/http-cart.json");
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function session<T>(
  fn: (client: StarbucksClient) => Promise<T>,
): Promise<T> {
  const file = program.opts().session;
  let jar: CookieJar;
  try {
    jar = await CookieJar.deserialize(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "No HTTP session. Use auth login or auth import --file <file>.",
      );
    throw new Error("Invalid HTTP cookie jar");
  }
  const transport = new HttpTransport({ cookieJar: jar });
  try {
    return await fn(new StarbucksClient(transport));
  } finally {
    await writePrivate(file, await jar.serialize());
  }
}
async function readCart(): Promise<Cart> {
  try {
    return JSON.parse(await fs.readFile(program.opts().cart, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createCart();
    throw error;
  }
}
async function saveCart(cart: Cart): Promise<void> {
  await writePrivate(program.opts().cart, cart);
}
const api = new StarbucksClient();
program
  .command("stores")
  .requiredOption("--place <place>")
  .option("--lat <number>")
  .option("--lng <number>")
  .action(async (o) => {
    if ((o.lat === undefined) !== (o.lng === undefined))
      throw new Error("Provide both --lat and --lng");
    const stores = await api.stores(
      o.place,
      o.lat === undefined
        ? undefined
        : { lat: Number(o.lat), lng: Number(o.lng) },
    );
    print(
      stores.map((s) => ({
        storeNumber: s.store.storeNumber,
        name: s.store.name,
        address: s.store.address.singleLine,
        distance: s.distance,
        open: s.store.open,
        mobileOrdering: s.store.mobileOrdering,
      })),
    );
  });
program
  .command("menu")
  .option("--search <term>")
  .action(async (o) =>
    print(o.search ? await api.searchMenu(o.search) : await api.menu()),
  );
program
  .command("product")
  .argument("<id>")
  .option("--form <form>", "product form", "hot")
  .option("--options", "show sizes and customization options")
  .action(async (id, o) => {
    const p = await api.product(Number(id), o.form);
    if (!o.options) {
      print(p);
      return;
    }
    const categories: unknown[] = [];
    const walk = (cs: OptionCategory[]) => {
      for (const c of cs) {
        if (c.products.length)
          categories.push({
            category: c.name,
            options: c.products.map((p) => ({
              id: p.productNumber,
              name: p.form.name,
              form: p.form.formCode,
              sizes: p.form.sizes,
            })),
          });
        walk(c.children ?? []);
      }
    };
    walk(p.productOptions);
    print({
      id: p.productNumber,
      name: p.name,
      sizes: p.sizes.map((s) => ({
        name: s.name,
        sku: s.sku,
        default: s.default,
      })),
      categories,
    });
  });
const auth = program.command("auth");
auth.command("status").action(() =>
  session(async (s) => {
    await s.user();
    print({ authenticated: true, session: program.opts().session });
  }),
);
auth
  .command("import")
  .requiredOption(
    "--file <file>",
    "cookie jar, storage-state JSON, or exported cookie array",
  )
  .action(async (o) => {
    const jar = await importCookieJar(
      JSON.parse(await fs.readFile(o.file, "utf8")),
    );
    // Verify via direct fetch before replacing the existing session file.
    await new StarbucksClient(new HttpTransport({ cookieJar: jar })).user();
    await writePrivate(program.opts().session, await jar.serialize());
    print({ authenticated: true, session: program.opts().session });
  });
auth
  .command("login")
  .description("Open a browser for manual sign-in, save cookies, then close it")
  .option("--timeout <seconds>", "time allowed for sign-in", "300")
  .action(async (o) => {
    const timeoutMs = Number(o.timeout) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("Invalid login timeout");
    const { loginWithBrowser } = await import("./browser-login.js");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    console.error(
      "Sign in in the browser window. It will close automatically after your account is verified and cookies are saved.",
    );
    try {
      await loginWithBrowser({
        sessionFile: program.opts().session,
        timeoutMs,
        signal: controller.signal,
      });
      print({ authenticated: true, session: program.opts().session });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  });

program.command("cards").action(() =>
  session(async (s) => {
    const cards = await s.cards();
    if (!Array.isArray(cards)) throw new Error("Card list unavailable");
    print(
      cards.map((c) => ({
        nickname: c.nickname,
        lastFour: String(c.cardNumber ?? "").slice(-4),
        isPrimary: c.isPrimary,
        balance: c.balance,
      })),
    );
  }),
);
program.command("wallet").action(() =>
  session(async (s) => {
    const w = await s.wallet();
    const instruments = w.paymentInstruments;
    print({
      paymentInstruments: Array.isArray(instruments)
        ? instruments.map((p) => ({
            paymentType: p.paymentType,
            lastFour: p.accountNumberLastFour,
            default: p.default,
            status: p.instrumentStatusCode,
          }))
        : [],
      storedValueCardCount: Array.isArray(w.storedValueCards)
        ? w.storedValueCards.length
        : 0,
    });
  }),
);
program
  .command("store")
  .requiredOption("--place <place>")
  .requiredOption("--name <name>")
  .requiredOption("--lat <number>")
  .requiredOption("--lng <number>")
  .description("Select the pickup café")
  .action(async (o) => {
    const locations = await api.stores(o.place, {
      lat: Number(o.lat),
      lng: Number(o.lng),
    });
    const location = locations.find(
      (l) => l.store.name.toLowerCase() === o.name.toLowerCase(),
    );
    if (!location) throw new Error("Named store not found");
    if (location.store.mobileOrdering?.availability !== "READY")
      throw new Error("Store is not ready for mobile ordering");
    const cart = await readCart();
    cart.storeNumber = location.store.storeNumber;
    await saveCart(cart);
    print({ selected: location.store.name, storeNumber: cart.storeNumber });
  });
const cart = program.command("cart");
cart.command("show").action(async () => print(await readCart()));
cart
  .command("add")
  .requiredOption("--product <id>")
  .option("--form <form>", "product form", "hot")
  .option("--size <size>", "size", "Grande")
  .option("--milk <milk>")
  .option("--shots <count>")
  .option("--quantity <count>", "quantity", "1")
  .action(async (o) => {
    const product = await api.product(Number(o.product), o.form);
    const result = addItem(
      await readCart(),
      createItem(product, {
        size: o.size,
        milk: o.milk,
        shots: o.shots === undefined ? undefined : Number(o.shots),
        quantity: Number(o.quantity),
      }),
    );
    await saveCart(result);
    print(result);
  });
cart
  .command("decrease")
  .argument("<index>")
  .action(async (index) => {
    const result = decreaseItem(await readCart(), Number(index));
    await saveCart(result);
    print(result);
  });
cart
  .command("build")
  .requiredOption("--product <id>")
  .requiredOption("--store <number>", "full store number, such as 114-101752")
  .option("--form <form>", "product form", "hot")
  .option("--size <size>", "size", "Grande")
  .option("--milk <milk>")
  .option("--shots <count>")
  .option("--quantity <count>", "quantity", "1")
  .option("--out <file>", "local draft cart", ".starbucks/draft-cart.json")
  .action(async (o) => {
    const product = await api.product(Number(o.product), o.form);
    const result: Cart = {
      version: 1,
      storeNumber: o.store,
      items: [
        createItem(product, {
          size: o.size,
          milk: o.milk,
          shots: o.shots === undefined ? undefined : Number(o.shots),
          quantity: Number(o.quantity),
        }),
      ],
    };
    toOrder(result);
    await writePrivate(o.out, result);
    print({ file: o.out, cart: result, localOnly: true });
  });
cart
  .command("quote")
  .option("--file <file>", "price a different local cart file")
  .option("--guest", "explicitly use guest pricing")
  .action((o) =>
    session(async (s) => {
      const input: Cart = o.file
        ? JSON.parse(await fs.readFile(o.file, "utf8"))
        : await readCart();
      const quote = await s.quote(input, o.guest ? "guest" : "member");
      await writePrivate(".starbucks/latest-quote.json", quote);
      print(quote);
    }),
  );
cart
  .command("preflight")
  .description("Fetch account status, member quote, and wallet; never submit")
  .action(() =>
    session(async (s) => {
      const input = await readCart();
      await s.user();
      const quote = await s.quote(input);
      const wallet = await s.wallet();
      print({
        authenticated: true,
        quote,
        walletLoaded: !!wallet,
        orderSubmitted: false,
        note: "API preflight only; does not verify final checkout acceptance.",
      });
    }),
  );
program
  .command("order")
  .description("Disabled: this version cannot submit an order")
  .action(() => {
    throw new Error("Order submission is disabled. No order was placed.");
  });
await program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
