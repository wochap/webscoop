# llm-adapter Specification

## Purpose

Defines the client used to talk to a language model through an OpenAI-compatible chat completions endpoint, how it is configured, how requests and responses are shaped and validated, how failures degrade, and the mock that stands in for it in tests.

## Requirements

### Requirement: Configuration
The adapter SHALL be configured from the `llm` block of the config file: `endpoint` (base URL ending before `/chat/completions`, for example `http://127.0.0.1:11434/v1`), `model`, optional `apiKey` sent as a bearer token, optional `contextTokens` (default 32768), optional `timeoutMs` (default 60000), optional `temperature` (default 0). Environment variables `WEBSCOOP_LLM_ENDPOINT`, `WEBSCOOP_LLM_MODEL`, and `WEBSCOOP_LLM_API_KEY` SHALL override the file. The adapter SHALL report itself unavailable when `endpoint` or `model` is missing.

#### Scenario: Endpoint from environment
- **WHEN** the config file has no `llm` block and `WEBSCOOP_LLM_ENDPOINT` and `WEBSCOOP_LLM_MODEL` are set
- **THEN** the adapter is available and uses those values

#### Scenario: Missing model
- **WHEN** `endpoint` is set and `model` is not
- **THEN** the adapter is unavailable and no request is made

### Requirement: Request shape
A completion request SHALL be a POST to `<endpoint>/chat/completions` with `model`, `messages`, `temperature`, `max_tokens`, `stream: false`, and `response_format: { "type": "json_object" }` when JSON output is requested. When the caller marks the request as `noThinking`, the adapter SHALL send `chat_template_kwargs: { "enable_thinking": false }` and prepend nothing else. The adapter SHALL send `Authorization: Bearer <apiKey>` only when a key is configured.

#### Scenario: JSON request
- **WHEN** a JSON completion is requested with `noThinking`
- **THEN** the request body contains `response_format.type` `json_object`, `stream` false, and `chat_template_kwargs.enable_thinking` false

### Requirement: Response handling
The adapter SHALL return the first choice's message content. When JSON output was requested, it SHALL strip a leading `<think>...</think>` block and surrounding code fences, parse the JSON, validate it against the caller's schema, and on failure retry the request once with an appended instruction to output only JSON. A second failure SHALL be reported as an adapter error naming the schema path that failed. HTTP errors, timeouts, and network errors SHALL be reported as adapter errors carrying the status or cause; the adapter SHALL NOT throw across the port boundary in a way that aborts the caller's larger operation.

#### Scenario: Fenced JSON accepted
- **WHEN** the model answers with a JSON object wrapped in a markdown code fence
- **THEN** the parsed object is returned

#### Scenario: Malformed twice
- **WHEN** the model answers with non-JSON twice
- **THEN** the adapter returns an error result naming the failure and the caller can continue

#### Scenario: Endpoint down
- **WHEN** the endpoint refuses the connection
- **THEN** the adapter returns an error result within the timeout and does not retry

### Requirement: Token estimation
The adapter SHALL expose a token estimate for a string (characters divided by 3.5, rounded up) and the configured context size, so callers can budget prompts without a tokenizer.

#### Scenario: Budget check
- **WHEN** a caller estimates a 20000 character prompt
- **THEN** the estimate is 5715 tokens

### Requirement: Endpoint probe
The adapter SHALL offer a probe that requests `<endpoint>/models`, reports whether the configured model is listed, and measures the round trip of a one-token completion. The probe SHALL complete within the configured timeout and never throw.

#### Scenario: Model missing from list
- **WHEN** `/models` lists `qwen3.5:9b` and the configured model is `qwen3.5:14b`
- **THEN** the probe reports the model as not found and lists the available names

### Requirement: Mock adapter
A mock adapter SHALL implement the same port, answer from a scripted list of responses matched in order or by a predicate on the prompt, record every request it received, and report itself available. Tests SHALL be able to script malformed responses and errors.

#### Scenario: Scripted pick
- **WHEN** the mock is scripted to answer `{ "index": 2, "reason": "price with currency" }`
- **THEN** a JSON completion returns that object and the request is recorded
