# Code Review for PI WEB

Review workspace files and staged/unstaged Git changes, save line-range comments, and insert or copy the feedback into a conversation. This standalone plugin uses public PI WEB APIs; no host patch is required.

Requires Node.js 22.19+ and PI WEB 1.202610.1 or newer. Prompt insertion additionally needs the public selection service on upstream main (introduced after 1.202610.1); older hosts support review and copy.

```sh
cd plugins/code-review
npm ci --ignore-scripts
npm run verify
```

Install the built directory using the [installation and usage guide](docs/usage.md). It is not bundled or enabled automatically, and has not been published to npm.

See [development](docs/development.md) for verification and packaging. Adapted from the Code Review UI branch and PI WEB's MIT-licensed plugin examples; see [LICENSE](LICENSE).
