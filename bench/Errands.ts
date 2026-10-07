// Operate tasks on everyday pages, each a chore people do on the web: dragging a card on a board,
// finding a policy behind menus that open on hover, and comparing a catalogue across pages before
// buying. Like the bench's other operate pages, each varies with the seed, and each grader reads the
// page, not only the answer.
import { Duration, Effect, Schema } from "effect";

import { style, truth } from "./Sites.ts";
import { operate, press, type Task } from "./Tasks.ts";

// Seeded helpers each page script starts with, over the stream `serve` injects.
const draws = (salt: number) =>
  `const random = __benchStream(${salt}), pick = (list) => list[Math.floor(random() * list.length)];
  const shuffle = (list) => list.map((item) => [random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);`;

const target = "Rotate the API keys";

// A sprint board whose cards move by dragging alone: pointer down on a card, up over a column.
const board = `<!doctype html><html><head><title>Sprint board | Harbor Tools</title><style>${style}
body{background:#f4f5f7;color:#172b4d}h1{margin:16px 24px}
#board{display:grid;grid-template-columns:repeat(4,240px);gap:16px;padding:0 24px}
.column{background:#ebecf0;border-radius:8px;padding:8px;min-height:440px}
.column h2{font-size:15px;margin:4px 4px 10px}
.card{background:#fff;border-radius:6px;padding:10px;margin:0 0 8px;box-shadow:0 1px 2px #091e4240;user-select:none;cursor:grab;touch-action:none}
.card.lifted{opacity:.5}
</style></head><body><h1>Sprint board</h1><div id="board"></div><script>
  ${draws(0xb0a4)}
  const columns = ["To do", "In progress", "Review", "Done"];
  const pool = ["Fix the login timeout", "Update the privacy page", "Add CSV export", "Review the invoice emails", "Migrate the reports job", "Tidy the settings menu", "Write the onboarding guide", "Cache the search results", "Retire the old billing API", "Audit the admin roles", "Translate the help pages", "Speed up the image upload"];
  const state = Object.fromEntries(columns.map((name) => [name, []]));
  const cards = shuffle(pool).slice(0, 9), done = Math.floor(random() * 4);
  cards.forEach((card, index) => state[index < done ? "Done" : pick(columns.slice(0, 3))].push(card));
  const home = state[pick(columns.slice(0, 3))];
  home.splice(Math.floor(random() * (home.length + 1)), 0, "${target}");
  window.__bench = { columns: state, initial: JSON.parse(JSON.stringify(state)) };
  const root = document.getElementById("board");
  const render = () => {
    root.innerHTML = columns.map((name) => '<section class="column" data-name="' + name + '"><h2>' + name + '</h2>' + state[name].map((title) => '<div class="card" data-title="' + title + '">' + title + '</div>').join("") + '</section>').join("");
    __benchSettled(() => {});
  };
  let lifted = null;
  root.addEventListener("pointerdown", (event) => {
    lifted = event.target.closest(".card");
    if (lifted === null) return;
    lifted.classList.add("lifted");
    lifted.setPointerCapture(event.pointerId);
  });
  root.addEventListener("pointerup", (event) => {
    if (lifted === null) return;
    const card = lifted, title = card.dataset.title, from = card.closest(".column").dataset.name;
    lifted = null; card.classList.remove("lifted");
    const column = document.elementsFromPoint(event.clientX, event.clientY).map((element) => element.closest(".column")).find((found) => found !== null);
    if (column === undefined) return;
    const to = column.dataset.name;
    const others = [...column.querySelectorAll(".card")].filter((element) => element !== card);
    const before = others.findIndex((element) => { const box = element.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
    state[from] = state[from].filter((name) => name !== title);
    const list = state[to].filter((name) => name !== title);
    list.splice(before === -1 ? list.length : before, 0, title);
    state[to] = list;
    render();
  });
  render();
</script></body></html>`;

const BoardTruth = Schema.Struct({
  columns: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  initial: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});

const without = (cards: ReadonlyArray<string> | undefined) =>
  (cards ?? []).filter((card) => card !== target).join("|");

const boardMove = operate({
  name: "board-move",
  summary: "Drag a card to the top of a board's Done column, and report how many cards Done holds",
  start: "/errands/board",
  pages: { "/errands/board": board },
  prompt: `Drag the card "${target}" to the top of the Done column. Then report how many cards the Done column holds.`,
  answer: Schema.Struct({ done: Schema.Finite }),
  maxSteps: 15,
  solve: (page) =>
    Effect.gen(function* () {
      const [card] = yield* page.find({ text: target });
      const [column] = yield* page.find({ role: "heading", name: "Done" });

      if (card === undefined || column === undefined)
        return yield* Effect.die("the board shows no target card or no Done column");
      // Dropped on the heading, the card goes above every card in the column.
      yield* page.drag(card.ref, column.ref);

      return { done: ((yield* truth(page, BoardTruth)).columns["Done"] ?? []).length };
    }),
  grade: (answer, page) =>
    truth(page, BoardTruth).pipe(
      Effect.map(({ columns, initial }) => {
        const done = columns["Done"] ?? [];

        const moved = Object.keys(initial).filter(
          (name) => without(columns[name]) !== without(initial[name]),
        );

        return {
          pass: done[0] === target && moved.length === 0 && answer.done === done.length,
          onPage: done[0] === target && moved.length === 0,
          detail: `Done holds ${done.length === 0 ? "nothing" : done.join(", ")}${moved.length === 0 ? "" : `; other cards moved in ${moved.join(", ")}`}. The answer reported ${answer.done}.`,
        };
      }),
    ),
});

// A shop whose policies hide behind header menus that open on hover, with a decoy beside them.
const menus = `<!doctype html><html><head><title>Help | Harbor Goods</title><style>${style}
body{background:#fff;color:#222}header{background:#16324f;color:#fff;padding:0 24px}
nav{display:flex;gap:4px}.menu{position:relative}.menu>button{padding:16px 18px;background:none;border:0;color:inherit}
.items{display:none;position:absolute;top:100%;left:0;background:#fff;min-width:240px;box-shadow:0 8px 24px #0003;border-radius:0 0 8px 8px;z-index:2}
.menu:hover .items,.menu:focus-within .items{display:block}.items a{display:block;padding:10px 16px;color:#16324f;text-decoration:none}
.items a:hover{background:#eef3f8}main{padding:24px}
</style></head><body><header><nav id="nav"></nav></header><main><h1>How can we help?</h1>
<p>Questions about an order? Our team answers within a day.</p></main><script>
  ${draws(0x4e1b)}
  const returns = pick(["Returns policy", "Returns and refunds policy", "Our returns policy"]);
  const shipping = pick(["Shipping policy", "Delivery and shipping policy"]);
  const holder = pick(["Orders", "Help", "Account"]);
  const menus = { Shop: ["Tents", "Lanterns", "Sleeping bags", "Gift cards"], Orders: ["Track an order", "Order history"], Help: ["Contact us", "Size guides"], Account: ["Sign in", "Saved addresses"] };
  menus[holder].push(returns); menus[pick(["Orders", "Help", "Account"])].push(shipping);
  const links = { [returns]: "/errands/help/returns", [shipping]: "/errands/help/shipping" };
  document.getElementById("nav").innerHTML = Object.entries(menus).map(([name, items]) => '<div class="menu"><button aria-haspopup="true">' + name + '</button><div class="items">' + shuffle(items).map((item) => '<a href="' + (links[item] ?? "#") + '">' + item + '</a>').join("") + '</div></div>').join("");
  window.__bench = { page: "help", code: null, menu: holder, link: returns };
</script></body></html>`;

// A policy page; both policies' codes come from the same seeded draws, so each page knows its own.
const policy = (
  kind: "returns" | "shipping",
) => `<!doctype html><html><head><title>${kind === "returns" ? "Returns" : "Shipping"} policy | Harbor Goods</title><style>${style}
body{padding:24px;color:#222}</style></head><body><script>
  ${draws(0x9c0d)}
  const codes = { returns: "RP-" + (10000 + Math.floor(random() * 90000)), shipping: "SP-" + (10000 + Math.floor(random() * 90000)) };
  document.body.insertAdjacentHTML("afterbegin", "<h1>${kind === "returns" ? "Returns" : "Shipping"} policy</h1><p>Reference " + codes["${kind}"] + "</p><p>${kind === "returns" ? "Unused items can come back within 30 days of delivery, for a full refund to the original payment." : "Orders ship within two working days; tracking follows by email."}</p>");
  window.__bench = { page: "${kind}", code: codes["${kind}"] };
</script></body></html>`;

const PolicyTruth = Schema.Struct({ page: Schema.String, code: Schema.NullOr(Schema.String) });

const HelpLayout = Schema.Struct({ menu: Schema.String, link: Schema.String });

const policyFind = operate({
  name: "policy-find",
  summary:
    "Find the returns policy behind header menus that open on hover, and report its reference",
  start: "/errands/help",
  pages: {
    "/errands/help": menus,
    "/errands/help/returns": policy("returns"),
    "/errands/help/shipping": policy("shipping"),
  },
  prompt:
    "Find the shop's returns policy through the menus at the top of the page, open it, and report its reference code.",
  answer: Schema.Struct({ code: Schema.String }),
  maxSteps: 15,
  solve: (page) =>
    Effect.gen(function* () {
      const layout = yield* truth(page, HelpLayout);
      const [menu] = yield* page.find({ role: "button", name: layout.menu });

      if (menu === undefined) return yield* Effect.die(`the header has no ${layout.menu} menu`);
      yield* page.hover(menu.ref);
      yield* press(page, "link", layout.link);
      yield* page.ready({ quietMillis: 150, timeout: Duration.seconds(5) });

      return { code: (yield* truth(page, PolicyTruth)).code ?? "" };
    }),
  grade: (answer, page) =>
    truth(page, PolicyTruth).pipe(
      Effect.map((shown) => ({
        pass: shown.page === "returns" && answer.code === shown.code,
        onPage: shown.page === "returns",
        detail: `The tab shows the ${shown.page} page${shown.code === null ? "" : `, reference ${shown.code}`}. The answer reported ${answer.code === "" ? "no code" : answer.code}.`,
      })),
    ),
});

// A catalogue of tents across three pages, where the cheapest tent for two is not the cheapest
// tent, and is not always in stock.
const shop = `<!doctype html><html><head><title>Tents | Harbor Outdoor</title><style>${style}
body{background:#fafaf7;color:#222;padding:0 24px 24px}header{display:flex;justify-content:space-between;align-items:center}
#grid{display:grid;grid-template-columns:repeat(3,300px);gap:16px}article{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px}
article h3{margin:0 0 6px;font-size:17px}.price{font-weight:bold}.out{color:#b00}
button{padding:8px 14px}nav{margin-top:16px;display:flex;gap:8px}
</style></head><body><header><h1>Tents</h1><p id="cart" role="status">Cart: empty</p></header>
<div id="grid"></div><nav id="pages"></nav><script>
  ${draws(0x7e47)}
  const names = shuffle(["Ridge", "Summit", "Meadow", "Harbor", "Canyon", "Aspen", "Fjord", "Tundra", "Cedar", "Glacier", "Prairie", "Delta", "Mesa", "Juniper", "Sierra", "Coast", "Alder", "Basin"]);
  const sizes = shuffle([1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
  const prices = shuffle(Array.from({ length: 18 }, (_, index) => 89 + index * 17 + Math.floor(random() * 9)));
  const products = names.map((name, index) => ({ name: name + " " + (sizes[index] === 1 ? "Solo" : sizes[index] + "P") + " tent", sleeps: sizes[index], price: prices[index], inStock: random() < 0.75 }));
  // The cheapest tent for two is sold out on some seeds, so the next one is the answer there.
  const forTwo = products.filter((product) => product.sleeps === 2).sort((a, b) => a.price - b.price);
  forTwo[0].inStock = random() < 0.5; forTwo[1].inStock = true;
  products.filter((product) => product.sleeps === 1).forEach((product) => { product.inStock = true; });
  const cart = [];
  window.__bench = { products, cart, total: 0 };
  let current = 0;
  const money = (value) => "$" + value.toFixed(2);
  const render = () => {
    document.getElementById("grid").innerHTML = products.slice(current * 6, current * 6 + 6).map((product, index) => '<article><h3>' + product.name + '</h3><p>Sleeps ' + product.sleeps + '</p><p class="price">' + money(product.price) + '</p><p class="' + (product.inStock ? "" : "out") + '">' + (product.inStock ? "In stock" : "Sold out") + '</p><button data-index="' + (current * 6 + index) + '"' + (product.inStock ? "" : " disabled") + '>Add to cart</button></article>').join("");
    document.getElementById("pages").innerHTML = '<button id="previous"' + (current === 0 ? " disabled" : "") + '>Previous</button><span>Page ' + (current + 1) + ' of 3</span><button id="next"' + (current === 2 ? " disabled" : "") + '>Next</button>';
    document.getElementById("cart").textContent = cart.length === 0 ? "Cart: empty" : "Cart: " + cart.length + " item" + (cart.length === 1 ? "" : "s") + ", total " + money(__bench.total);
    __benchSettled(() => {});
  };
  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button === null || button.disabled) return;
    if (button.id === "previous") current -= 1;
    else if (button.id === "next") current += 1;
    else { const product = products[Number(button.dataset.index)]; cart.push({ name: product.name, price: product.price }); __bench.total = cart.reduce((sum, item) => sum + item.price, 0); }
    render();
  });
  render();
</script></body></html>`;

const Product = Schema.Struct({
  name: Schema.String,
  sleeps: Schema.Finite,
  price: Schema.Finite,
  inStock: Schema.Boolean,
});

const ShopTruth = Schema.Struct({
  products: Schema.Array(Product),
  cart: Schema.Array(Schema.Struct({ name: Schema.String, price: Schema.Finite })),
  total: Schema.Finite,
});

const cheapestForTwo = (products: ReadonlyArray<typeof Product.Type>) =>
  products
    .filter((product) => product.sleeps === 2 && product.inStock)
    .toSorted((left, right) => left.price - right.price)[0];

const catalogBuy = operate({
  name: "catalog-buy",
  summary: "Compare a catalogue across pages, add the cheapest tent for two in stock to the cart",
  start: "/errands/shop",
  pages: { "/errands/shop": shop },
  prompt:
    "Add the cheapest tent that sleeps two people and is in stock to the cart, and only that tent. Then report the cart's total in dollars.",
  answer: Schema.Struct({ total: Schema.Finite }),
  maxSteps: 25,
  solve: (page) =>
    Effect.gen(function* () {
      const wanted = cheapestForTwo((yield* truth(page, ShopTruth)).products);

      if (wanted === undefined) return yield* Effect.die("the catalogue has no tent for two");

      for (let shown = 0; shown < 3; shown++) {
        const [add] = yield* page.find({
          role: "button",
          name: "Add to cart",
          near: wanted.name,
          scope: "document",
        });

        if (add !== undefined) {
          yield* page.click(add.ref);
          break;
        }
        yield* press(page, "button", "Next");
      }

      return { total: (yield* truth(page, ShopTruth)).total };
    }),
  grade: (answer, page) =>
    truth(page, ShopTruth).pipe(
      Effect.map((shopped) => {
        const wanted = cheapestForTwo(shopped.products);
        const [only] = shopped.cart;

        return {
          pass:
            shopped.cart.length === 1 &&
            only?.name === wanted?.name &&
            Math.abs(answer.total - shopped.total) < 0.005,
          onPage: shopped.cart.length === 1 && only?.name === wanted?.name,
          detail: `The cart holds ${shopped.cart.length === 0 ? "nothing" : shopped.cart.map((item) => item.name).join(", ")}; the cheapest tent for two in stock is the ${wanted?.name ?? "none"}. The answer reported $${answer.total}, the cart $${shopped.total.toFixed(2)}.`,
        };
      }),
    ),
});

/** The errands, in the order the bench lists them. */
export const tasks: ReadonlyArray<Task> = [boardMove, policyFind, catalogBuy];
