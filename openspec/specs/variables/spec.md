# variables Specification

## Purpose

Defines where a recipe's variable values come from, how secret and path variables behave, and how secret values are kept out of recipes, output, logs, and hooks.

## Requirements

### Requirement: Variable value sources
For each variable a run, test, or recording session needs, the value SHALL be taken from the first source that gives one, in this order:
1. the command line: `--var name=value`, `--var-file name=PATH` (the file's content with one trailing newline removed), or `--var-command name=CMD` (the trimmed standard output of `CMD` run with `/bin/sh -c`)
2. the config file's `vars` block: `vars.<recipe name>.<variable name>`, an object with exactly one of `value` (a string), `file` (a path, `~` expanded, relative to the config file's directory), or `command` (run with `/bin/sh -c` in the config file's directory, trimmed standard output)
3. the recipe variable's `default`

Giving more than one command line source for the same variable SHALL be an error naming it. A config binding with zero or several of `value`, `file`, and `command` SHALL be a config error naming the recipe and the variable. Sources SHALL be read before the browser opens, and only for variables the recipe declares. A command that exits non-zero, cannot start, or runs longer than 30 seconds, or a file that cannot be read, SHALL fail the command with exit 1, naming the variable and the source, without printing the source's output. A variable left without a value SHALL fail with exit 1, as today.

#### Scenario: Password from pass
- **WHEN** the config binds `vars.sunat-menu.pass` to `{ "command": "pass show sunat/sol" }` and `webscoop run sunat-menu` runs
- **THEN** the run uses the command's trimmed output as `pass`

#### Scenario: Command line wins
- **WHEN** the config binds `ruc` to a file and `--var ruc=20100000001` is passed
- **THEN** the run uses `20100000001` and the file is not read

#### Scenario: Failing command
- **WHEN** the bound command for `pass` exits 1
- **THEN** the command exits 1 naming `pass` and the command source, and the browser does not open

### Requirement: Secret variables
A variable declared `secret` SHALL NOT have a `default`. Its value SHALL NOT appear in:
- the recipe file, including after write-back or a recorder save
- stdout rows
- stderr lines
- the run report
- events
- hook environment or stdin
- language model prompts
- error messages

A secret value substituted into the URL template SHALL be rejected: validation SHALL fail when the template uses a secret variable. In the report and events, a secret variable SHALL be listed by name with its value replaced by `***`.

#### Scenario: Secret in a fill
- **WHEN** a flow fills `{pass}`, `pass` is secret, and the run fails on that step
- **THEN** stderr names the step and the variable `pass`, and does not contain its value

#### Scenario: Secret with a default
- **WHEN** a recipe declares `pass` as secret with a `default`
- **THEN** validation fails naming `pass`

### Requirement: Path variables
A variable with `type` `path` SHALL hold one or more file paths separated by `:`. Relative paths SHALL be resolved against the working directory of the command that submitted the run. Before a `fill` step uses a path variable, the runner SHALL check that every path names a readable file. Otherwise the run SHALL fail with exit 1, naming the variable and the missing path. A path variable MAY have a `default`.

#### Scenario: Upload two files
- **WHEN** `--var clips=a.mp4:b.mp4` is passed, both files exist, and a `fill` step targets a multiple file input with `{clips}`
- **THEN** the input receives both files

#### Scenario: Missing file
- **WHEN** `--var video=missing.mp4` is passed and the file does not exist
- **THEN** the run fails before that step's action with exit 1, naming `video` and `missing.mp4`
