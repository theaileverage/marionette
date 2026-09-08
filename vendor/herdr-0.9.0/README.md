# Herdr 0.9.0 socket schema

`api.schema.json` is the unmodified output of `herdr api schema --json` from the installed Herdr 0.9.0 binary (protocol 22). The corresponding upstream release is https://github.com/herdrdev/herdr/tree/v0.9.0. The upstream Apache-2.0 license is retained in `LICENSE`.

Marionette generates TypeScript declarations and its method registry with `npm run sdk:generate`. The generated types describe wire structure; Herdr enforces numeric ranges, feature availability, and other semantic constraints. The documented `pane.graphics.stream` transport is handled separately because upstream omits it from this JSON schema; its contract comes from `src/api/schema/panes.rs` and `src/api/server/pane_graphics_stream.rs` at the same tag.
