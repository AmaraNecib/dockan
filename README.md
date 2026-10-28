# Products scrolling evidence

Source head: 72ae2c0dcd296de088d00ac5fcc61d77f2d2ec30.

The before image is a runtime ablation at the final head: remove the pager buttons' relative class in the browser DOM. No source files changed. This produces 1750px document overflow, scrollY1750 and sidebarY-1750. Restoring the original relative classes produces overflow0,scrollY0,sidebarY0 and a fully visible sidebar.

The capture uses a fresh authenticated test shop,61 products,page size50 and a1920x1080 viewport. comparison.mp4 is40.04seconds at native FullHD; the inline GIF is960x540 at8fps. Before/after crops use the identical bottom-right1080x600 bounds, preserving sidebar and pager context; the before crop is blank because the app scrolled offscreen. Images contain only synthetic test data. Full source screenshots are included.

The repository's preferred R2 helper is absent in this checkout and no R2 credentials are configured. These public evidence-only branch assets are kept outside the product PR's diff.

Model: openai-codex-b2/gpt-6.1-sol
Thinking: medium
Harness: pi
Agent: parent-products-scroll
