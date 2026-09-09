# Repository banner

`banner.svg` is the README image. It uses SVG shapes and text, with no scripts,
remote fonts, embedded raster images or external asset requests.

To add a provider or change its status:

1. Edit `providers` at the top of [`scripts/banner.mjs`](../../scripts/banner.mjs).
2. Choose an `icon` from the inline SVG marks and set `status` to
   `experimental` or `available`. Add a vector mark to `icons` for a new provider.
   Only include implemented integrations; planned providers stay out of the banner.
3. Run `npm run banner:generate` and review `docs/assets/banner.svg` in a browser.

The design follows the original README banner: monospace title, solid black
background, a central pixel mascot and provider icons connected by spokes. Provider
rows and canvas height expand automatically. Palette, wording and layout live in
the same script. Keep changes there; direct SVG edits are overwritten.
`npm run banner:check` (also part of CI's `npm run check`) verifies exact output.
The README supplies alt text; the SVG also contains a title and description.

The OpenAI mark comes from [Simple Icons 11.0.0](https://github.com/simple-icons/simple-icons/blob/11.0.0/icons/openai.svg),
under [CC0](https://github.com/simple-icons/simple-icons/blob/11.0.0/LICENSE.md).
Other marks are editable vector interpretations for this banner, not official brand assets.

The accent is Anthropic orange `#d97757`, with `#faf9f5` light text and `#b0aea5`
secondary text from [Anthropic’s brand guidelines](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md).
The background is pure black (`#000000`), with no gradient or texture.
