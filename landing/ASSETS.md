# MoreTime artwork

The landing page uses original artwork generated with the built-in image generation tool.

- File: [dist/assets/moretime-hero.png](dist/assets/moretime-hero.png)
- Dimensions: 1536 × 1024 pixels
- Usage: hero illustration, with separate HTML conversation bubbles animated over it.

The illustration gently floats and tilts with the pointer on supported desktop devices. These movements are implemented in CSS and JavaScript; the underlying artwork is unchanged.

## Icons and favicon

Interface icons are locally hosted Google [Material Symbols Rounded](https://github.com/google/material-design-icons), distributed under the [Apache 2.0 license](dist/assets/icons/LICENSE). Original downloaded SVGs are in `dist/assets/icons/` and their paths are embedded as SVG symbols in `index.html` with inherited color.

Included symbols: `receipt_long`, `schedule`, `tune`, `north_east`, `arrow_forward`, `pause`, `play_arrow`, and `replay`. Source pattern: `https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web/{name}/materialsymbolsrounded/{name}_24px.svg`.

The favicon at `dist/assets/favicon.svg` is an original SVG based on MoreTime's existing three-bar wordmark.

## Generation prompt

> Use case: stylized-concept. Asset type: original MoreTime landing page hero illustration. Create an exceptionally polished playful 3D editorial still life, wide landscape on a pure white background: a tall white paper bill with abstract blue horizontal lines curls into an arch through a large cobalt blue rounded chat bubble ring; small tomato red sphere, golden yellow half sphere, pale blue inflated speech bubble, and mint green rounded rectangular block balance around it. Tactile matte clay and paper materials, crisp soft studio shadows, sophisticated whimsical composition with generous negative space, frontal three-quarter camera. Inspired by playful modern technology product campaign art. No text, numbers, logos, watermark, people, or background gradients. All objects fully in frame. White background.
