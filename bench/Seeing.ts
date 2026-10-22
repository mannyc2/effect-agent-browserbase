// Operate tasks whose pages show what matters in pixels more than in text: a toolbar of icons no
// button names, seats whose color alone says which are free, and a list of payments that look
// alike. Each can be done from the outline alone, by hovering for tooltips, clicking to probe or
// reading rows in order, but a picture shows it at once, so these tasks tell apart the ways an agent
// is shown the page. Like the errands, each page varies with the seed, and each grader reads the
// page, not only the answer.
import { Effect, Schema } from "effect";

import { draws, style, truth } from "./Sites.ts";
import { operate, press, quotes, type Task } from "./Tasks.ts";

const Code = Schema.Struct({ code: Schema.String });

const reported = (code: string) => (code === "" ? "no code" : code);

// A note editor whose toolbar buttons show icons alone, so the outline names none of them; each
// says what it does in a tooltip on hover. A comment beside the note asks for the formatting.
const note = `<!doctype html><html><head><title>Team notes | Quill</title><style>${style}
body{background:#f6f7f9;color:#1f2328}header{background:#fff;padding:12px 24px;font-weight:600;border-bottom:1px solid #d8dee4}
#toolbar{display:flex;align-items:center;gap:2px;padding:6px 24px;background:#fff;border-bottom:1px solid #d8dee4}
#toolbar button{width:34px;height:34px;border:0;border-radius:6px;background:none;color:#424a53;display:grid;place-items:center}
#toolbar button:hover{background:#eaeef2}#toolbar button.on{background:#ddf4ff;color:#0969da}
#toolbar .gap{width:1px;height:22px;background:#d8dee4;margin:0 8px}
#toolbar svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.swatch{width:16px;height:16px;border-radius:50%}#toolbar button.on .swatch{box-shadow:0 0 0 2px #fff,0 0 0 4px #0969da}
main{display:grid;grid-template-columns:1fr 260px;gap:24px;padding:24px}
#note{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:8px 32px 24px;line-height:1.6}
aside{background:#fff8c5;border:1px solid #eac54f;border-radius:8px;padding:12px 16px;align-self:start}
#status{margin:0 24px;color:#59636e}
#tip{position:absolute;background:#24292f;color:#fff;font-size:12px;padding:4px 8px;border-radius:4px;pointer-events:none}
</style></head><body><header>Quill</header><div id="toolbar"></div>
<main><article id="note"><h1 id="heading"></h1><div id="text"></div></article>
<aside><strong>Comment from Priya</strong><p id="ask"></p></aside></main>
<p id="status" role="status">Draft, not saved</p><div id="tip" hidden></div><script>
  ${draws(0x1c07)}
  const codes = __benchStream(0x1c08);
  const icons = {
    bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
    italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4M4 20h16"/>',
    strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16"/>',
    left: '<path d="M21 6H3M15 12H3M17 18H3"/>',
    center: '<path d="M21 6H3M17 12H7M19 18H5"/>',
    right: '<path d="M21 6H3M21 12H9M21 18H7"/>',
    justify: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    bullets: '<path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13"/>',
    undo: '<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7"/>',
  };
  const tips = { bold: "Bold (Ctrl+B)", italic: "Italic (Ctrl+I)", underline: "Underline (Ctrl+U)", strike: "Strikethrough", left: "Align left", center: "Align center", right: "Align right", justify: "Justify", bullets: "Bulleted list", undo: "Undo", redo: "Redo", save: "Save (Ctrl+S)" };
  const colors = { black: "#1f2328", red: "#cf222e", green: "#1a7f37", blue: "#0969da", purple: "#8250df" };
  // Each group keeps its usual order; the seed orders the groups and the swatches, with Save last.
  const groups = shuffle([["bold", "italic", "underline", "strike"], ["left", "center", "right", "justify"], ["bullets"], shuffle(Object.keys(colors)).map((color) => "color:" + color), ["undo", "redo"]]);
  const tools = groups.flat().concat(["save"]);
  const ask = { style: pick(["bold", "italic", "underline"]), align: pick(["center", "right", "justify"]), color: pick(["red", "green", "blue", "purple"]) };
  const styled = { bold: "bold", italic: "italic", underline: "underlined" };
  const aligned = { center: "centered", right: "aligned to the right", justify: "justified" };
  document.getElementById("ask").textContent = "Before you save it, could you make the note's text " + styled[ask.style] + " and " + ask.color + ", " + aligned[ask.align] + "? Leave everything else as it is.";
  document.getElementById("heading").textContent = pick(["Launch checklist", "Planning for next quarter", "Support rota", "Design review", "Hiring loop"]);
  const lines = shuffle(["Agree an owner for each open item by Friday.", "Move the weekly sync to Tuesday mornings.", "Share the draft with the wider team for comments.", "Book a room for the review session.", "Collect last quarter's numbers before the meeting.", "Send a summary to everyone who missed the call."]).slice(0, 3);
  const button = (tool) => '<button id="t' + tools.indexOf(tool) + '">' + (tool.startsWith("color:") ? '<span class="swatch" style="background:' + colors[tool.slice(6)] + '"></span>' : '<svg viewBox="0 0 24 24">' + icons[tool] + '</svg>') + '</button>';
  const toolbar = document.getElementById("toolbar"), status = document.getElementById("status");
  toolbar.innerHTML = groups.concat([["save"]]).map((group) => group.map(button).join("")).join('<span class="gap"></span>');
  let history = [{ bold: false, italic: false, underline: false, strike: false, bullets: false, align: "left", color: "black" }], at = 0;
  window.__bench = { ask, tools, saved: null };
  const render = () => {
    const now = history[at], text = document.getElementById("text");
    tools.forEach((tool, index) => document.getElementById("t" + index).classList.toggle("on", now[tool] === true || now.align === tool || "color:" + now.color === tool));
    Object.assign(text.style, { fontWeight: now.bold ? "700" : "400", fontStyle: now.italic ? "italic" : "normal", textDecoration: (now.underline ? "underline " : "") + (now.strike ? "line-through" : "") || "none", textAlign: now.align, color: colors[now.color] });
    text.innerHTML = now.bullets ? "<ul>" + lines.map((line) => "<li>" + line + "</li>").join("") + "</ul>" : lines.map((line) => "<p>" + line + "</p>").join("");
    __benchSettled(() => {});
  };
  const move = (to) => { at = to; status.textContent = "Unsaved changes"; render(); };
  const change = (patch) => { history = history.slice(0, at + 1).concat([Object.assign({}, history[at], patch)]); move(at + 1); };
  toolbar.addEventListener("click", (event) => {
    const pressed = event.target.closest("button");
    if (pressed === null) return;
    const tool = tools[Number(pressed.id.slice(1))], now = history[at];
    if (typeof now[tool] === "boolean") change({ [tool]: !now[tool] });
    else if (["left", "center", "right", "justify"].includes(tool)) change({ align: tool });
    else if (tool.startsWith("color:")) change({ color: tool.slice(6) });
    else if (tool === "undo" && at > 0) move(at - 1);
    else if (tool === "redo" && at < history.length - 1) move(at + 1);
    else if (tool === "save") {
      __bench.saved = Object.assign({ code: "R-" + (1000 + Math.floor(codes() * 9000)) }, history[at]);
      status.textContent = "Saved as revision " + __bench.saved.code;
    }
  });
  const tip = document.getElementById("tip");
  let showing;
  toolbar.addEventListener("pointerover", (event) => {
    const hovered = event.target.closest("button");
    clearTimeout(showing);
    tip.hidden = true;
    if (hovered === null) return;
    showing = setTimeout(() => {
      const box = hovered.getBoundingClientRect(), tool = tools[Number(hovered.id.slice(1))];
      tip.textContent = tool.startsWith("color:") ? "Text color: " + tool.slice(6) : tips[tool];
      Object.assign(tip.style, { left: box.left + scrollX + "px", top: box.bottom + scrollY + 6 + "px" });
      tip.hidden = false;
    }, 120);
  });
  toolbar.addEventListener("pointerleave", () => { clearTimeout(showing); tip.hidden = true; });
  render();
</script></body></html>`;

const Formatting = Schema.Struct({
  bold: Schema.Boolean,
  italic: Schema.Boolean,
  underline: Schema.Boolean,
  strike: Schema.Boolean,
  bullets: Schema.Boolean,
  align: Schema.String,
  color: Schema.String,
});

type Formatting = typeof Formatting.Type;

const NoteTruth = Schema.Struct({
  ask: Schema.Struct({ style: Schema.String, align: Schema.String, color: Schema.String }),
  tools: Schema.Array(Schema.String),
  saved: Schema.NullOr(Schema.Struct({ ...Formatting.fields, code: Schema.String })),
});

const asked = (ask: typeof NoteTruth.Type.ask): Formatting => ({
  bold: ask.style === "bold",
  italic: ask.style === "italic",
  underline: ask.style === "underline",
  strike: false,
  bullets: false,
  align: ask.align,
  color: ask.color,
});

const alignments: Readonly<Record<string, string>> = {
  left: "aligned left",
  center: "centered",
  right: "aligned right",
  justify: "justified",
};

// Formatting in words, the same for what was asked and what was saved.
const described = (formatting: Formatting) =>
  [
    ...(["bold", "italic", "underline", "strike", "bullets"] as const).filter(
      (flag) => formatting[flag],
    ),
    alignments[formatting.align] ?? formatting.align,
    formatting.color,
  ].join(", ");

const noteFormat = operate({
  name: "note-format",
  summary:
    "Format a note as a comment asks through a toolbar of unnamed icons, save it and report the revision",
  start: "/seeing/note",
  pages: { "/seeing/note": note },
  prompt:
    "Format the note as the comment beside it asks, using the editor's toolbar, then save the note. Report the revision code the page shows once it is saved.",
  answer: Code,
  maxSteps: 15,
  solve: (page) =>
    Effect.gen(function* () {
      const { ask, tools } = yield* truth(page, NoteTruth);

      for (const tool of [ask.style, ask.align, `color:${ask.color}`, "save"]) {
        const [found] = yield* page.find({ selector: `#t${tools.indexOf(tool)}` });

        if (found === undefined) return yield* Effect.die(`the toolbar has no ${tool} button`);
        yield* page.click(found.ref);
      }

      return { code: (yield* truth(page, NoteTruth)).saved?.code ?? "" };
    }),
  grade: (answer, page) =>
    truth(page, NoteTruth).pipe(
      Effect.map(({ ask, saved }) => {
        const wanted = described(asked(ask));
        const kept = saved === null ? undefined : described(saved);

        return {
          pass: kept === wanted && quotes(answer.code, saved?.code),
          onPage: kept === wanted,
          detail: `${saved === null ? "The note was never saved" : `The last save, revision ${saved.code}, kept ${kept}`}; the comment asked for ${wanted}. The answer reported ${reported(answer.code)}.`,
        };
      }),
    ),
});

const rows = "ABCDEFGH";

// A theatre's seat map that shows which seats are free by color alone. Clicking a taken seat says
// so in a passing notice; clicking a free one adds it to the seats listed below the map.
const seats = `<!doctype html><html><head><title>Choose seats | Harbor Playhouse</title><style>${style}
body{background:#15171e;color:#e6e7eb;padding:0 32px 32px}h1{margin:20px 0 4px;font-size:24px}
.legend{display:flex;gap:20px;margin:12px 0 20px;color:#b9bcc6}.legend i{display:inline-block;width:14px;height:14px;border-radius:4px;margin-right:6px;vertical-align:-2px}
.free{background:#38b27b}.taken{background:#4d525e}.mine{background:#4c8dff}
#stage{width:540px;margin:0 0 18px 30px;padding:6px;text-align:center;border-radius:0 0 40px 40px;background:#2a2e39;color:#9aa0ad;letter-spacing:.3em;font-size:12px}
.row{display:flex;align-items:center;gap:6px;margin:6px 0}.row b{width:24px;color:#9aa0ad;font-weight:500}
.seat{width:38px;height:30px;border:0;border-radius:8px 8px 4px 4px;font-size:11px;color:#15171e}.seat.taken{color:#3c404a;cursor:default}
#chosen{margin:18px 0 10px}#go{padding:10px 22px;border:0;border-radius:8px;background:#4c8dff;color:#fff;font-weight:600}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#e6e7eb;color:#15171e;padding:10px 16px;border-radius:8px}
</style></head><body><h1>Choose your seats</h1><p>The Glass Orchard, tonight at 19:30, in the stalls.</p>
<main id="picker"><div class="legend"><span><i class="free"></i>Available</span><span><i class="taken"></i>Unavailable</span><span><i class="mine"></i>Your seats</span></div>
<div id="stage">STAGE</div><div id="map"></div><p id="chosen" role="status">No seats chosen yet</p><button id="go">Continue</button></main>
<section id="done" hidden></section><div id="toast" role="alert" hidden></div><script>
  ${draws(0x5ea7)}
  const codes = __benchStream(0x5ea8);
  const letters = "${rows}".split(""), width = 12, answer = 2 + Math.floor(random() * 3);
  // Rows nearer the stage than the answer row have free seats only apart; the answer row has one
  // free pair, and lone free seats away from it; rows behind it are drawn at random.
  const free = letters.map((_, row) => {
    const open = Array.from({ length: width }, () => false);
    if (row < answer) for (let seat = Math.floor(random() * 2); seat < width; seat += 2 + Math.floor(random() * 2)) open[seat] = random() < 0.75;
    else if (row === answer) {
      const pair = Math.floor(random() * (width - 1));
      open[pair] = open[pair + 1] = true;
      for (let seat = 0; seat < width; seat++) if ((seat < pair - 1 || seat > pair + 2) && !open[seat - 1] && random() < 0.35) open[seat] = true;
    } else for (let seat = 0; seat < width; seat++) open[seat] = random() < 0.45;
    return open;
  });
  window.__bench = { free, booked: null };
  const map = document.getElementById("map"), toast = document.getElementById("toast"), chosen = [];
  map.innerHTML = letters.map((letter, row) => '<div class="row"><b>' + letter + '</b>' + free[row].map((open, seat) => '<button class="seat ' + (open ? "free" : "taken") + '" id="' + letter + (seat + 1) + '" aria-label="Row ' + letter + ', seat ' + (seat + 1) + '">' + (seat + 1) + '</button>').join("") + '</div>').join("");
  let hiding;
  const notice = (text) => { toast.textContent = text; toast.hidden = false; clearTimeout(hiding); hiding = setTimeout(() => { toast.hidden = true; }, 2500); };
  map.addEventListener("click", (event) => {
    const seat = event.target.closest(".seat");
    if (seat === null) return;
    if (seat.classList.contains("taken")) return notice(seat.getAttribute("aria-label") + " is unavailable. Please choose another seat.");
    const index = chosen.indexOf(seat.id);
    if (index === -1) chosen.push(seat.id); else chosen.splice(index, 1);
    seat.classList.toggle("mine", index === -1);
    seat.classList.toggle("free", index !== -1);
    document.getElementById("chosen").textContent = chosen.length === 0 ? "No seats chosen yet" : "Your seats: " + chosen.join(", ");
    __benchSettled(() => {});
  });
  document.getElementById("go").addEventListener("click", () => {
    if (chosen.length === 0) return notice("Choose your seats first.");
    __bench.booked = { seats: chosen.slice(), code: "HP-" + (10000 + Math.floor(codes() * 90000)) };
    document.getElementById("picker").hidden = true;
    const done = document.getElementById("done");
    done.innerHTML = "<h2>Booking confirmed</h2><p>Seats " + chosen.join(", ") + "</p><p>Booking reference " + __bench.booked.code + "</p>";
    done.hidden = false;
    __benchSettled(() => {});
  });
  __benchSettled(() => {});
</script></body></html>`;

const SeatTruth = Schema.Struct({
  free: Schema.Array(Schema.Array(Schema.Boolean)),
  booked: Schema.NullOr(Schema.Struct({ seats: Schema.Array(Schema.String), code: Schema.String })),
});

// The row nearest the stage with two free seats side by side, as the map opened, and its first
// such seat's index.
const pairOf = (free: typeof SeatTruth.Type.free) => {
  const row = free.findIndex((open) =>
    open.some((seat, index) => seat && open[index + 1] === true),
  );

  const seat = free[row]?.findIndex((open, index) => open && free[row]?.[index + 1] === true) ?? -1;

  return { row: rows.charAt(row), seat };
};

const seatBook = operate({
  name: "seat-book",
  summary:
    "Book the two seats together nearest the stage on a seat map that shows free seats by color alone",
  start: "/seeing/seats",
  pages: { "/seeing/seats": seats },
  prompt:
    "Book two seats side by side in the row nearest the stage that still has two free seats together. Confirm the booking, and report its reference.",
  answer: Code,
  maxSteps: 20,
  solve: (page) =>
    Effect.gen(function* () {
      const { row, seat } = pairOf((yield* truth(page, SeatTruth)).free);

      for (const number of [seat + 1, seat + 2])
        yield* press(page, "button", `Row ${row}, seat ${number}`);
      yield* press(page, "button", "Continue");

      return { code: (yield* truth(page, SeatTruth)).booked?.code ?? "" };
    }),
  grade: (answer, page) =>
    truth(page, SeatTruth).pipe(
      Effect.map(({ free, booked }) => {
        const { row } = pairOf(free);

        const [first, second] = (booked?.seats ?? [])
          .filter((seat) => seat.startsWith(row))
          .map((seat) => Number(seat.slice(1)))
          .toSorted((left, right) => left - right);

        const together =
          booked?.seats.length === 2 &&
          first !== undefined &&
          second !== undefined &&
          second - first === 1;

        return {
          pass: together && quotes(answer.code, booked.code),
          onPage: together,
          detail: `${booked === null ? "Nothing was booked" : `Booked ${booked.seats.join(", ")}, reference ${booked.code}`}; the row nearest the stage with two free seats together is ${row}. The answer reported ${reported(answer.code)}.`,
        };
      }),
    ),
});

// A merchant's payments, newest first, many alike: the payment a support ticket asks about shares
// all but one detail with a payment the next day, one the same day for an amount with two digits
// swapped, and one to a customer whose name differs by a letter or two.
const payments = `<!doctype html><html><head><title>Payments | Harbor Merchant</title><style>${style}
body{background:#f7f8fa;color:#1a1f36}header{background:#fff;border-bottom:1px solid #e3e8ee;padding:14px 32px;font-weight:600}
main{padding:12px 32px 32px}#ticket{background:#fff;border:1px solid #e3e8ee;border-left:4px solid #635bff;border-radius:6px;padding:12px 16px;max-width:760px}
table{border-collapse:collapse;width:100%;max-width:1100px;margin-top:20px;background:#fff;border:1px solid #e3e8ee}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #eef0f3;font-size:14px}th{color:#697386;font-weight:500}
tr.refunded td{color:#697386}td button{padding:5px 12px;border:1px solid #d5dbe1;border-radius:6px;background:#fff}
dialog{border:0;border-radius:10px;padding:20px 24px;box-shadow:0 12px 40px #0004}dialog button{padding:8px 14px;margin-left:8px}
</style></head><body><header>Harbor Merchant</header><main><h1>Payments</h1><section id="ticket"></section>
<table><thead><tr><th>Date</th><th>Customer</th><th>Description</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></main>
<dialog id="confirm"><p id="question"></p><form method="dialog"><button value="cancel">Cancel</button><button value="refund">Confirm refund</button></form></dialog><script>
  ${draws(0xfa11)}
  const codes = __benchStream(0xfa12);
  const twins = { "Maya Chen": "Mia Chen", "Leo Park": "Lea Park", "Sara Lind": "Sara Lindt", "Jon Ruiz": "Joan Ruiz" };
  const people = Object.keys(twins).concat(Object.values(twins), ["Omar Haddad", "Ines Duarte", "Tom Weller", "Priya Nair"]);
  const items = ["Linen shirt", "Canvas tote", "Wool beanie", "Gift card", "Leather wallet", "Rain jacket"];
  const money = (cents) => "$" + (cents / 100).toFixed(2);
  const when = (payment) => "Oct " + payment.day + ", " + String(Math.floor(payment.minute / 60)).padStart(2, "0") + ":" + String(payment.minute % 60).padStart(2, "0");
  const who = pick(Object.keys(twins)), day = 10 + Math.floor(random() * 9), item = pick(items);
  // An amount whose last two digits differ, so swapping them makes another amount.
  let cents = 2000 + Math.floor(random() * 8000);
  if (Math.floor(cents / 10) % 10 === cents % 10) cents += cents % 10 === 9 ? -1 : 1;
  const swapped = cents - (cents % 100) + (cents % 10) * 10 + Math.floor(cents / 10) % 10;
  const target = { who, day, cents, item };
  const alike = [{ who, day: day + 1, cents, item }, { who, day, cents: swapped, item: pick(items) }, { who: twins[who], day, cents, item }];
  const others = Array.from({ length: 23 }, () => ({ who: pick(people.filter((person) => person !== who)), day: 1 + Math.floor(random() * 20), cents: 900 + Math.floor(random() * 15000), item: pick(items) }));
  const list = [target].concat(alike, others).map((payment) => Object.assign(payment, { minute: Math.floor(random() * 1440) })).sort((a, b) => b.day * 1440 + b.minute - (a.day * 1440 + a.minute));
  document.getElementById("ticket").innerHTML = "<strong>Support ticket from " + who + "</strong><p>I sent back the " + item.toLowerCase() + " I bought on October " + day + " for " + money(cents) + ". Could you refund that payment, please?</p>";
  document.getElementById("rows").innerHTML = list.map((payment, index) => '<tr id="p' + index + '"><td>' + when(payment) + '</td><td>' + payment.who + '</td><td>' + payment.item + '</td><td>' + money(payment.cents) + '</td><td class="status">Succeeded</td><td><button>Refund</button></td></tr>').join("");
  window.__bench = { target: list.indexOf(target), payments: list.map((payment) => ({ who: payment.who, day: payment.day, cents: payment.cents, refund: null })) };
  const dialog = document.getElementById("confirm");
  let pending = null;
  document.getElementById("rows").addEventListener("click", (event) => {
    const refund = event.target.closest("button");
    if (refund === null) return;
    pending = Number(refund.closest("tr").id.slice(1));
    const payment = list[pending];
    document.getElementById("question").textContent = "Refund " + money(payment.cents) + " to " + payment.who + " for the payment of " + when(payment) + "?";
    dialog.returnValue = "";
    dialog.showModal();
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "refund" || pending === null) return;
    const code = "RF-" + (100000 + Math.floor(codes() * 900000)), row = document.getElementById("p" + pending);
    __bench.payments[pending].refund = code;
    row.classList.add("refunded");
    row.querySelector(".status").textContent = "Refunded, " + code;
    row.querySelector("button").remove();
    pending = null;
    __benchSettled(() => {});
  });
  __benchSettled(() => {});
</script></body></html>`;

const PaymentsTruth = Schema.Struct({
  target: Schema.Int,
  payments: Schema.Array(
    Schema.Struct({
      who: Schema.String,
      day: Schema.Int,
      cents: Schema.Int,
      refund: Schema.NullOr(Schema.String),
    }),
  ),
});

const paid = (payment: (typeof PaymentsTruth.Type.payments)[number]) =>
  `${payment.who}'s $${(payment.cents / 100).toFixed(2)} of ${payment.day} October`;

const paymentRefund = operate({
  name: "payment-refund",
  summary: "Refund the one payment a support ticket describes, among payments that look alike",
  start: "/seeing/payments",
  pages: { "/seeing/payments": payments },
  prompt:
    "Refund the payment the support ticket at the top of the page asks about, and no other. Report the refund's reference.",
  answer: Code,
  maxSteps: 15,
  solve: (page) =>
    Effect.gen(function* () {
      const { target } = yield* truth(page, PaymentsTruth);
      const [refund] = yield* page.find({ selector: `#p${target} button`, scope: "document" });

      if (refund === undefined)
        return yield* Effect.die("the asked-for payment has no Refund button");
      yield* page.click(refund.ref);
      yield* press(page, "button", "Confirm refund");

      return { code: (yield* truth(page, PaymentsTruth)).payments[target]?.refund ?? "" };
    }),
  grade: (answer, page) =>
    truth(page, PaymentsTruth).pipe(
      Effect.map(({ target, payments }) => {
        const refunded = payments.flatMap((payment, index) =>
          payment.refund === null ? [] : [{ ...payment, index }],
        );

        const wanted = payments[target];
        const right = refunded.length === 1 && refunded[0]?.index === target;

        return {
          pass: right && quotes(answer.code, wanted?.refund),
          onPage: right,
          detail: `${refunded.length === 0 ? "Nothing was refunded" : `Refunded ${refunded.map(paid).join("; ")}`}; the ticket asked about ${wanted === undefined ? "no listed payment" : paid(wanted)}. The answer reported ${reported(answer.code)}.`,
        };
      }),
    ),
});

/** The tasks, in the order the bench lists them. */
export const tasks: ReadonlyArray<Task> = [noteFormat, seatBook, paymentRefund];
