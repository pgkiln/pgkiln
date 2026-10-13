# App Gallery

The builder's **App Gallery** (`/builder/gallery`) lists what `gallery.json` names:

- `samples`: applications shipped with pgkiln, installed by an administrator: `example` names a directory of
  `examples/` (installed like `pgkiln migrate --example <name>`), `file` a single SQL file in `examples/`.
  `alias` is the application they create (an installed one shows Run and Edit).
- `starters`: [blueprints](../../docs/guide/03-builder.md#creating-an-application-from-a-blueprint) in `starters/`.
  Install opens the blueprint's review; the developer creates the application from it.

Add a starter by writing a blueprint file in `starters/` and an entry in `gallery.json` (a key of lower-case
letters, digits and `-`, a title, an [icon name](../../docs/guide/09-reference.md#icons) and a description).
`test/gallery.test.ts` creates every starter and opens all its pages.
