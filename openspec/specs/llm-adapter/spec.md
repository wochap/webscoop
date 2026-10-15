# llm-adapter Specification

## Purpose

Defines the client used to talk to a language model through an OpenAI-compatible chat completions endpoint, how it is configured, how requests and responses are shaped and validated, how failures degrade, and the mock that stands in for it in tests.

## Requirements

### Requirement: Configuration
An LLM entry SHALL have: `endpoint` (base URL ending before `/chat/completions`, for example `http://127.0.0.1:11434/v1`), `model`, optional `apiKey` sent as a bearer token, optional `apiKeyFile` naming a file whose trimmed contents are the bearer token, optional `apiKeyCommand` naming a shell command whose trimmed standard output is the bearer token, optional `contextTokens` (default 32768), optional `maxOutputTokens` (positive integer, default 4096), optional `maxTokensField` (`max_tokens`, the default, or `max_completion_tokens`), optional `effort` (`none`, `low`, `medium`, `high`, or `default`; default `default`), optional `timeoutMs` (default 60000), optional `retryBudgetMs` (non-negative integer, default 60000), optional `temperature` (default 0), and optional `models` as defined by "Per-model overrides". The config file's `llm` block SHALL be the entry named `default`. The config file MAY declare `llms`, a map from entry name to entry; an entry name SHALL be kebab-case, and `llms` SHALL NOT define `default`. Validation errors SHALL name the entry's JSON path (`$.llm` or `$.llms.<name>`).

A relative `apiKeyFile` SHALL resolve against the directory of the config file, and a leading `~/` SHALL expand to the home directory. `apiKeyCommand` SHALL have no default. An entry SHALL be invalid when more than one of `apiKey`, `apiKeyFile`, and `apiKeyCommand` is set. The command SHALL run through `sh -c` with the config file directory as working directory, inherit the environment, and be killed after `timeoutMs` (default 60000); a non-zero exit, a timeout, or empty output SHALL be a CLI error that includes the exit status and standard error but never standard output. Environment variables `WEBSCOOP_LLM_ENDPOINT`, `WEBSCOOP_LLM_MODEL`, `WEBSCOOP_LLM_API_KEY`, and `WEBSCOOP_LLM_API_KEY_FILE` SHALL override the `default` entry only; `WEBSCOOP_LLM_API_KEY` SHALL win over `WEBSCOOP_LLM_API_KEY_FILE`, and either SHALL win over every config key source of the `default` entry. A relative `WEBSCOOP_LLM_API_KEY_FILE` SHALL resolve against the working directory. An entry's key file SHALL be read, and its key command run, only when an adapter for that entry is built with an endpoint and a model, and at most once per command per entry; a key file that cannot be read or is empty after trimming SHALL be a CLI error naming the path. An adapter SHALL report itself unavailable when its entry's `endpoint` or `model` is missing.

#### Scenario: Endpoint from environment
- **WHEN** the config file has no `llm` block and `WEBSCOOP_LLM_ENDPOINT` and `WEBSCOOP_LLM_MODEL` are set
- **THEN** the `default` adapter is available and uses those values

#### Scenario: Environment leaves named entries alone
- **WHEN** `llms.fast` sets endpoint `http://a/v1` and `WEBSCOOP_LLM_ENDPOINT` is `http://b/v1`
- **THEN** the `fast` adapter uses `http://a/v1` and the `default` adapter uses `http://b/v1`

#### Scenario: Missing model
- **WHEN** `endpoint` is set and `model` is not
- **THEN** the adapter is unavailable and no request is made

#### Scenario: Key from file
- **WHEN** `llm.apiKeyFile` is `secrets/llm-key` and that file next to the config contains `sk-abc\n`
- **THEN** requests send `Authorization: Bearer sk-abc`

#### Scenario: Two key sources
- **WHEN** the config sets both `llm.apiKey` and `llm.apiKeyFile`, or `llms.fast.apiKeyFile` and `llms.fast.apiKeyCommand`
- **THEN** loading the config fails with an error at `$.llm` or `$.llms.fast`

#### Scenario: Reserved entry name
- **WHEN** the config declares `llms.default`
- **THEN** loading the config fails with an error at `$.llms.default` saying the `llm` block is the default entry

#### Scenario: Invalid output field
- **WHEN** `llms.fast.maxTokensField` is `max_output_tokens`
- **THEN** loading the config fails with an error at `$.llms.fast.maxTokensField` listing the two accepted values

#### Scenario: Environment key wins over key file
- **WHEN** `llm.apiKeyFile` is set and `WEBSCOOP_LLM_API_KEY` is set
- **THEN** the environment key is used and the file is not read

#### Scenario: Missing key file
- **WHEN** `llm.apiKeyFile` names a file that does not exist and an endpoint and model are configured
- **THEN** the command fails with an error naming the resolved path

#### Scenario: Key from command
- **WHEN** `llm.apiKeyCommand` is `pass show llm/openrouter` and the command prints `sk-xyz\n` and exits 0
- **THEN** requests send `Authorization: Bearer sk-xyz`

#### Scenario: Failing key command
- **WHEN** `llm.apiKeyCommand` exits non-zero and an endpoint and model are configured
- **THEN** the command fails with an error showing the exit status and standard error, and no request is made

#### Scenario: Environment key skips command
- **WHEN** `llm.apiKeyCommand` is set and `WEBSCOOP_LLM_API_KEY` is set
- **THEN** the command does not run

#### Scenario: Key read once per entry
- **WHEN** one command resolves the `default` entry twice and `llm.apiKeyCommand` is set
- **THEN** the command runs once

### Requirement: Entry resolution
A command SHALL obtain its adapter through a resolver that takes an optional caller name and the optional `--llm` flag value, and SHALL pick the first of: the caller name, the flag value, `default`. A name that neither `llm` nor `llms` defines SHALL be a CLI error naming the name and listing the defined entry names. When `WEBSCOOP_LLM_MOCK` is set, the resolver SHALL answer the mock adapter for every defined name and SHALL still reject an undefined name. The resolver SHALL build each entry's adapter at most once per command and SHALL return the same adapter for repeated requests of one name.

#### Scenario: Flag picks an entry
- **WHEN** `llms.fast` is defined and `webscoop run shop --llm fast` reaches the model rung
- **THEN** the request goes to the `fast` entry's endpoint with its model

#### Scenario: Caller name wins over the flag
- **WHEN** a caller names `smart`, `--llm fast` is given, and both entries are defined
- **THEN** the `smart` entry is used

#### Scenario: Unknown entry
- **WHEN** `webscoop run shop --llm nope` is executed and only `fast` is defined under `llms`
- **THEN** the command exits 1 with an error naming `nope` and listing `default` and `fast`, and no browser is started

#### Scenario: Mock covers every entry
- **WHEN** `WEBSCOOP_LLM_MOCK` is set and a caller names the defined entry `fast`
- **THEN** the mock adapter answers and no request leaves the process

### Requirement: Per-model overrides
An entry MAY declare `models`, a map from model id to an object with optional `contextTokens`, `maxOutputTokens`, and `effort`, each validated as the entry key of the same name. When the entry's `model` is a key of `models`, the override's values SHALL replace the entry's for that adapter (its effective values). Keys of `models` other than the entry's `model` SHALL have no effect on requests.

#### Scenario: Override applies to the selected model
- **WHEN** the entry has `contextTokens` 32768 and `models["big"].contextTokens` 131072 and `model` is `big`
- **THEN** the adapter reports `contextTokens` 131072

#### Scenario: Override for another model is inert
- **WHEN** the entry's `model` is `small` and only `models["big"]` is declared
- **THEN** the adapter uses the entry's own values

### Requirement: Request shape
A completion request SHALL be a POST to `<endpoint>/chat/completions` with `model`, `messages`, `temperature`, `stream: false`, the output cap, the effort keys, and `response_format: { "type": "json_object" }` when JSON output is requested. The output cap SHALL be sent under the entry's `maxTokensField` and SHALL be the smallest of the caller's `maxTokens`, the caller's `maxOutputTokens`, and the entry's effective `maxOutputTokens`, where given. The effort SHALL be the caller's `effort` when given, else the entry's effective `effort`; a caller's `noThinking` SHALL mean `effort` `none`. Effort `default` SHALL add no key. Effort `none` SHALL add `reasoning_effort: "none"` and `chat_template_kwargs: { "enable_thinking": false }`. Any other effort SHALL add `reasoning_effort: <effort>` only. When a request carrying `reasoning_effort` or `chat_template_kwargs` is answered with HTTP 400, the adapter SHALL send it once more without both keys. The adapter SHALL send `Authorization: Bearer <apiKey>` only when a key is configured.

#### Scenario: JSON request
- **WHEN** a JSON completion is requested with `noThinking`
- **THEN** the request body contains `response_format.type` `json_object`, `stream` false, `reasoning_effort` `none`, and `chat_template_kwargs.enable_thinking` false

#### Scenario: Output cap under the entry's field
- **WHEN** the entry sets `maxTokensField` `max_completion_tokens` and `maxOutputTokens` 1024 and the caller passes `maxTokens` 200
- **THEN** the body contains `max_completion_tokens` 200 and no `max_tokens`

#### Scenario: Entry effort applies
- **WHEN** the entry sets `effort` `high` and the caller passes no effort
- **THEN** the body contains `reasoning_effort` `high` and no `chat_template_kwargs`

#### Scenario: Effort rejected once
- **WHEN** the server answers HTTP 400 to a request with `reasoning_effort` `low`
- **THEN** the request is sent once more without `reasoning_effort`, and a second 400 is reported as an HTTP error

### Requirement: Response handling
The adapter SHALL return the first choice's message content. When JSON output was requested, it SHALL strip a leading `<think>...</think>` block and surrounding code fences, parse the JSON, validate it against the caller's schema, and on failure retry the request once with an appended instruction to output only JSON. A second failure SHALL be reported as an adapter error naming the schema path that failed. HTTP errors, timeouts, and network errors SHALL be reported as adapter errors carrying the status or cause, after the retry rule of "Retry on busy answers" has been applied; the adapter SHALL NOT throw across the port boundary in a way that aborts the caller's larger operation. No adapter error message SHALL contain the configured bearer token: any occurrence of it in a URL, header, or response text SHALL be replaced with `***`.

#### Scenario: Fenced JSON accepted
- **WHEN** the model answers with a JSON object wrapped in a markdown code fence
- **THEN** the parsed object is returned

#### Scenario: Malformed twice
- **WHEN** the model answers with non-JSON twice
- **THEN** the adapter returns an error result naming the failure and the caller can continue

#### Scenario: Endpoint down
- **WHEN** the endpoint refuses the connection
- **THEN** the adapter returns an error result within the timeout and does not retry

#### Scenario: Key echoed by the server
- **WHEN** the key is `sk-abc` and the server answers HTTP 401 with a body containing `sk-abc`
- **THEN** the error message contains `***` and not `sk-abc`

### Requirement: Retry on busy answers
When a completion request is answered with HTTP 429, 502, 503, 504, or 529, the adapter SHALL send it again after a wait, and SHALL NOT retry any other status, a network error, or a timeout. The first wait SHALL be 500 ms, each later wait double the previous, capped at 8000 ms; when the answer carries a `Retry-After` header as seconds or as an HTTP date, that wait SHALL be used instead, still capped at 8000 ms. The adapter SHALL stop retrying, and return the last error, when the next wait would end later than `retryBudgetMs` after the first attempt started; `retryBudgetMs` 0 SHALL disable retries. Each attempt SHALL be bounded by `timeoutMs` on its own. Before each wait the adapter SHALL report the status and the wait through its log callback when one is set.

#### Scenario: 503 then success
- **WHEN** the server answers 503 and then 200
- **THEN** the completion succeeds after one wait of 500 ms and the log callback received one line naming 503

#### Scenario: Retry-After honored
- **WHEN** the server answers 429 with `Retry-After: 2`
- **THEN** the next attempt starts about 2000 ms later

#### Scenario: Budget exhausted
- **WHEN** `retryBudgetMs` is 1000 and the server keeps answering 503
- **THEN** the adapter returns the 503 error within about 1500 ms and makes at most three attempts

#### Scenario: Retries off
- **WHEN** `retryBudgetMs` is 0 and the server answers 503
- **THEN** the adapter returns the error after one attempt

#### Scenario: 500 not retried
- **WHEN** the server answers HTTP 500
- **THEN** the adapter returns the error after one attempt

### Requirement: Token estimation
The adapter SHALL expose a token estimate for a string (characters divided by 3.5, rounded up) and the configured context size, so callers can budget prompts without a tokenizer.

#### Scenario: Budget check
- **WHEN** a caller estimates a 20000 character prompt
- **THEN** the estimate is 5715 tokens

### Requirement: Endpoint probe
The adapter SHALL offer a probe that requests `<endpoint>/models`, reports whether the configured model is listed, lists the configured per-model override ids that the endpoint does not list, and measures the round trip of a one-token completion. The probe SHALL complete within the configured timeout, SHALL NOT retry, and SHALL never throw.

#### Scenario: Model missing from list
- **WHEN** `/models` lists `qwen3.5:9b` and the configured model is `qwen3.5:14b`
- **THEN** the probe reports the model as not found and lists the available names

#### Scenario: Override for an unlisted model
- **WHEN** the entry's `models` has a key `gpt-x` and `/models` does not list it
- **THEN** the probe reports `gpt-x` as an override for an unlisted model

### Requirement: Mock adapter
A mock adapter SHALL implement the same port, answer from a scripted list of responses matched in order or by a predicate on the prompt, record every request it received, and report itself available. Tests SHALL be able to script malformed responses and errors.

#### Scenario: Scripted pick
- **WHEN** the mock is scripted to answer `{ "index": 2, "reason": "price with currency" }`
- **THEN** a JSON completion returns that object and the request is recorded
