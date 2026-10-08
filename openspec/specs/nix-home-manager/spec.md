# nix-home-manager Specification

## Purpose

Lets home-manager users install webscoop and manage its config file and runtime environment declaratively from their Nix configuration.

## Requirements

### Requirement: Module export
The flake SHALL export a home-manager module as `homeManagerModules.webscoop` and `homeManagerModules.default`, configured under `programs.webscoop`. With `programs.webscoop.enable` false the module SHALL change nothing.

#### Scenario: Disabled
- **WHEN** a home configuration imports the module and does not set `programs.webscoop.enable`
- **THEN** the generation contains no webscoop package and no `webscoop/config.json`

### Requirement: Package and completions
With `enable` true the module SHALL install `programs.webscoop.package` (default: the flake's webscoop package for the host system). `shellCompletions.enable` (default true) SHALL control whether the package's shell completions are installed; when false only `bin/` SHALL be installed.

#### Scenario: Completions off
- **WHEN** `enable` is true and `shellCompletions.enable` is false
- **THEN** `webscoop` is on the path and no webscoop zsh completion is installed

### Requirement: Environment
`programs.webscoop.environment` SHALL be an attribute set of strings. Each pair SHALL be set in the environment of every `webscoop` invocation by the installed binary, without changing the user's session variables. An empty set SHALL install the package unwrapped.

#### Scenario: CA bundle
- **WHEN** `environment.NODE_EXTRA_CA_CERTS` is `/etc/ssl/local-ca.pem`
- **THEN** the installed `webscoop` runs with `NODE_EXTRA_CA_CERTS=/etc/ssl/local-ca.pem`

### Requirement: Settings
`programs.webscoop.settings` SHALL be written as JSON to `$XDG_CONFIG_HOME/webscoop/config.json`, with option paths matching JSON paths. Keys without a typed option SHALL pass through unchanged. `settings.daemon.concurrency.total` SHALL be a positive integer, `settings.daemon.concurrency.perRecipe` a positive integer, `settings.daemon.concurrency.recipes` an attribute set of positive integers, and `settings.daemon.idleMs` a non-negative integer; each SHALL default to null, a null typed option SHALL be left out of the JSON (so webscoop applies its own default), and a value of the wrong type SHALL fail evaluation. When nothing is left to write, no config file SHALL be written.

#### Scenario: Daemon concurrency
- **WHEN** `settings.daemon.concurrency = { total = 3; perRecipe = 1; }` and `settings.browser.driver = "patchright"`
- **THEN** `config.json` contains `"daemon": { "concurrency": { "total": 3, "perRecipe": 1 } }` and `"browser": { "driver": "patchright" }`

#### Scenario: Unset typed options
- **WHEN** only `settings.browser.driver = "patchright"` is set
- **THEN** `config.json` has no `daemon` key

#### Scenario: Wrong type
- **WHEN** `settings.daemon.concurrency.total = 0`
- **THEN** evaluating the home configuration fails naming `programs.webscoop.settings.daemon.concurrency.total`

### Requirement: Checked by flake check
`nix flake check` SHALL build a home configuration that enables the module with `environment` and `settings` set, and SHALL fail when the generated `config.json` or the wrapped binary does not match the options.

#### Scenario: Check passes
- **WHEN** `nix flake check` runs on a clean checkout
- **THEN** the home-manager evaluation check succeeds
