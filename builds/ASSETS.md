# The workshop asset pack

`assets.json` is an index of small, licensed assets the builder may put into a workshop app, as data URIs, so every app stays one offline file. Only the assets a build references are injected into it. Rebuilt by hand; the script is not in the repo.

- **icons** (`icon_*`): from [game-icons.net](https://game-icons.net), CC BY 3.0. The background square is removed and the glyph is a single dark colour on transparent. Contributors credited in `credits.icons` inside the index, and "icons game-icons.net cc by" is appended to the corner line of any app that uses one.
- **sprites** (`animal_*`): from [Kenney](https://kenney.nl) Animal Pack Redux, CC0.
- **sounds** (`sfx_*`): from Kenney Impact Sounds and UI Audio, CC0.

Apps refer to an asset as `ASSETS.name`. The builder injects `<script>const ASSETS={...}</script>` into the head with just the names used, before the audit result is stored.
