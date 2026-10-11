// The site's routes.
import { pipe, Schema } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal, slash, string } from "foldkit/route";

export const AppRoute = defineRouteUnion({
  Home: {},
  Doc: { slug: Schema.String },
  Demo: {},
  Replay: { id: Schema.String },
  Try: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

export const docRouter = pipe(literal("docs"), slash(string("slug")), Route.mapTo(AppRoute.Doc));

export const demoRouter = pipe(literal("demo"), Route.mapTo(AppRoute.Demo));

export const replayRouter = pipe(
  literal("replay"),
  slash(string("id")),
  Route.mapTo(AppRoute.Replay),
);

export const tryRouter = pipe(literal("try"), Route.mapTo(AppRoute.Try));

export const urlToAppRoute = Route.parseUrlWithFallback(
  Route.oneOf(docRouter, demoRouter, replayRouter, tryRouter, homeRouter),
  AppRoute.NotFound,
);
