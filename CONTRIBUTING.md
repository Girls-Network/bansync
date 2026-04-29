# Contributing Guidelines

Thank you for considering contributing!

## How to Contribute

- Fork the repository
- Create a new branch for your feature or fix
- Submit a pull request with a clear description

## Code Quality Standards

Before opening a pull request, **you must run `npm run prettylint` and resolve every issue it reports.** This script chains our linter (`eslint --fix`) with our formatter (`prettier --write`) and is what CI runs against your branch. PRs that don't pass it will not be merged.

```bash
npm install        # if you haven't yet
npm run prettylint # lint + auto-fix + format the whole codebase
```

If `prettylint` reports errors that auto-fix can't resolve (e.g. type errors, banned patterns, unused identifiers), fix them by hand and re-run until the command exits cleanly. Don't disable rules to silence warnings unless you have a justified reason — and if you do, add an inline `// eslint-disable-next-line <rule>` with a short comment explaining why, scoped to the single line that needs it.

You should also run `npm run test` before pushing — it type-checks the whole codebase via `tsc --noEmit` and catches issues lint can't see (e.g. broken imports, misused generics).

In short, before every PR:

```bash
npm run prettylint && npm run test
```

If both commands exit 0 locally, CI will be happy too.

## Code of Conduct

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

- Please use issues for bug reports, feature requests, and questions.

## Commit Messages

- Use clear, descriptive commit messages.

## License

By contributing, you agree your contributions will be licensed under the repository's license.
