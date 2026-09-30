# ai-skill Specification

## Purpose

Ships an agent skill that lets AI harnesses discover the user's webscoop recipes, choose the one that fits a request, run it, and report the result, without the user naming recipes or flags.

## Requirements

### Requirement: Skill file
The repository SHALL contain `skills/webscoop-use-recipe/SKILL.md`, a Markdown file with YAML frontmatter holding `name: webscoop-use-recipe` and a `description` that says the skill scrapes web data with the user's saved webscoop recipes and when to use it (the user asks for data from a site or a search that a recipe may cover, or names webscoop). The body SHALL instruct the agent to:
- run `webscoop recipes --json` and choose a recipe by its `description`, its tables' descriptions and fields, and its variables' descriptions, and, when no recipe fits, tell the user so instead of guessing, and suggest recording one with `webscoop record <url>` run by the user;
- pass each variable with `--var name=value`, supplying every variable without a default;
- run `webscoop run <recipe> --jsonl --quiet`, adding `--table <name>` when only one table is needed, and read one JSON row per stdout line, each with the table's fields plus `_page` and `_index`, and `_table` when the recipe has several tables and `--table` is not given;
- interpret exit codes: 0 success; 1 an error to report with its stderr; 2 the browser needed the user (login or captcha) and nobody answered in time, so ask the user to handle the browser window and retry; 3 the page changed and a required field was not found, so tell the user the recipe needs repair with `webscoop edit <recipe>`;
- know that runs may be started in parallel and are queued or shared by webscoop, and that a run may pause while the user answers a prompt in the browser;
- never edit recipe files and never run `record`, `edit`, or `daemon stop` itself.

#### Scenario: Frontmatter present
- **WHEN** the skill file is parsed
- **THEN** its frontmatter has `name` equal to `webscoop-use-recipe` and a non-empty `description`

#### Scenario: Agent finds a search recipe
- **WHEN** an agent with the skill is asked "search cats" and `webscoop recipes --json` lists `bing-search` described "Bing web search results for a query" with variable `query` described "search terms"
- **THEN** the skill's instructions lead to `webscoop run bing-search --var query=cats --jsonl --quiet`

### Requirement: Skill stays in sync with the CLI
A test SHALL fail when the skill mentions a `webscoop` subcommand or a flag of `run` or `recipes` that the CLI does not define.

#### Scenario: Renamed flag
- **WHEN** `--jsonl` is renamed in the CLI but the skill still mentions `--jsonl`
- **THEN** the test suite fails and names `--jsonl`

### Requirement: Installed with the Nix package
The Nix package SHALL install the skill directory at `share/webscoop/skills/webscoop-use-recipe/` so that `SKILL.md` is at `share/webscoop/skills/webscoop-use-recipe/SKILL.md` in the package output.

#### Scenario: Home-manager source path
- **WHEN** the Nix package is built
- **THEN** `$out/share/webscoop/skills/webscoop-use-recipe/SKILL.md` exists and matches the repository file
