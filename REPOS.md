# Repository Boundary — PUBLIC RELEASES ONLY

> **You are in the public Mazzy release repository.**
>
> Remote: `https://github.com/mazurovn/Mazzy-Command-Center.git`
>
> This checkout is only for reviewed, sanitized releases for Pi and public use.

## Allowed here

- Public package source: `src/`, `static/`, `skills/`, `resources/`, `scripts/`
- Public-facing documentation, README translations, screenshots, tests, LICENSE
- Reviewed release changes copied deliberately from the private development repo

## Never put private development material here

Keep all of the following exclusively in:
the sibling **private development checkout**
(`Mazzy-Command-Center-private.git`)

- `research/`, audits, model-review reports, iterations
- Detailed/internal SDD or architecture decision records
- `.mazzy/`, control database, backlog seed, cutover/recovery data
- `.pi/` runtime/agent configuration, secrets, tokens, local logs

Local pre-commit and pre-push hooks reject private paths, database files, known
private markers/secrets, and any push to a remote other than the exact public URL.
Do **not** bypass hooks with `--no-verify`.

## Wiki

Public user documentation belongs in the separate wiki checkout:
`/home/mazurov/RESEARCH/Mazzy-Command-Center-wiki`
(`Mazzy-Command-Center.wiki.git`).
