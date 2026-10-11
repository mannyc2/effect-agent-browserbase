import { Runtime } from "foldkit";

import { init, Message, Model, update, view } from "./main.ts";

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    container: document.getElementById("root"),
    devTools: { Message },
  }),
);
