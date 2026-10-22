// Every task the bench runs: the tasks of `Tasks.ts`, then the errands of `Errands.ts`, then the
// tasks of `Seeing.ts`, whose pages show what matters in pixels more than in text.
import * as Errands from "./Errands.ts";
import * as Seeing from "./Seeing.ts";
import { type Task, tasks as core } from "./Tasks.ts";

export const tasks: ReadonlyArray<Task> = [...core, ...Errands.tasks, ...Seeing.tasks];
