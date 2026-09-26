## Summary

<!-- What does this PR change, and why? Keep it to a few sentences. -->

## Related issues

<!-- e.g. Closes #123 -->

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] ♻️ Refactor (no behavior change)
- [ ] 🧰 Build / tooling / CI
- [ ] 📝 Documentation

## How was this tested?

<!-- Commands run, manual steps, screenshots of the panel. -->
<!-- Say explicitly which parts are reviewed-but-unrun (Rust, desktop behavior). -->

## Checklist

- [ ] `pnpm run check` passes locally (format, lint, typecheck, version, tests)
- [ ] `pnpm run build` passes
- [ ] `pnpm run e2e` passes and `docs/screenshots/` looked at
- [ ] Rust changes: `cargo fmt --check`, `clippy -D warnings`, `check`, `test`
- [ ] New logic has unit tests
- [ ] Adapter changes have a fixture captured from a real status page
- [ ] Self-reviewed the diff and removed any debug code
- [ ] `docs/future-work.md` updated if scope moved across the MVP line
