// Every task the bench runs: the tasks of `Tasks.ts`, then the errands of `Errands.ts`.
import * as Errands from "./Errands.ts";
import { type Task, tasks as core } from "./Tasks.ts";

export const tasks: ReadonlyArray<Task> = [...core, ...Errands.tasks];
