# Notes for Claude

## Always publish a release

The owner wants every change shipped as a downloadable Windows release. After pushing a change:

1. Bump `version` in `package.json` (and `package-lock.json`): `npm version <x.y.z> --no-git-tag-version`.
   New features bump the minor version, fixes bump the patch version.
2. Commit and push.
3. Run the **Build Nibo AI** workflow (`.github/workflows/build.yml`) on the pushed branch with the input
   `release_tag: v<x.y.z>` (and, only when the owner wants specific text on the release, `release_notes: <text>`,
   which replaces the automatically generated notes). It builds the NSIS installer and the portable exe on a Windows runner, creates the tag
   on the built commit and attaches both files to the GitHub release. (Pushing a `v*` tag also works where tag
   pushes are allowed.)
4. Check that the release shows up with both `.exe` files.

## Checks before pushing

- `npm test` runs the unit tests (node:test, mock Groq and Tavily servers in `test/`).
- `npm run screenshots` (needs a display, e.g. Xvfb) drives the real app against the mocks and refreshes `docs/`.
