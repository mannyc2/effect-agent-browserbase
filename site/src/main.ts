import * as Markdown from "@foldkit/markdown";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

import hello from "./hello.md";

export const Model = Schema.Struct({ count: Schema.Number });
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({ ClickedIncrement: {} });
export type Message = typeof Message.Type;

export const init = () => ({ model: { count: 0 } });

export const update = (model: Model, message: Message) =>
  Message.match(message, { ClickedIncrement: () => ({ model: { count: model.count + 1 } }) });

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("p-8")],
    [
      Markdown.view(Markdown.decodeDocument(hello)),
      h.button([h.OnClick(Message.ClickedIncrement())], [`Clicked ${model.count}`]),
    ],
  );
